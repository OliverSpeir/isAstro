import {
	parseGeneratorTags,
	getAstroHeadMarkers,
	getAstroBodyMarkers,
	getAllAstroMarkers,
	checkMetaRefresh,
	isValidUrl,
	addProtocolToUrlAndTrim,
	isBotChallenge,
	CustomError,
	metaGeneratorRegex,
	metaRefreshRegex,
	astroDataAttrRegex,
	astroClassRegex,
	astroIslandRegex,
	astroAssetRegex,
	endOfHeadRegex,
	styleWhereRegex,
	styleAttrRegex,
} from "./utils";
export { isValidUrl, addProtocolToUrlAndTrim, CustomError };

export async function isAstroWebsite(
	url: string | URL,
	debug = false,
	currentRedirect = 0,
	maxRedirects = 3,
	originalUrl?: string,
) {
	if (!originalUrl) {
		originalUrl = url.toString();
	}

	const debugLog = debug
		? (...args: unknown[]) => {
				console.log(...args);
			}
		: // eslint-disable-next-line @typescript-eslint/no-empty-function
			() => {};

	const startTime = Date.now();
	let totalBytes = 0;

	debugLog(`[isAstroWebsite] Starting check for: ${url}`);
	const timeoutMs = 2000;
	const controller = new AbortController();
	const { signal } = controller;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const astroVersionRef: { value?: string } = {};
	const starlightVersionRef: { value?: string } = {};

	let response: Response | undefined;
	try {
		timeoutId = setTimeout(() => {
			controller.abort();
		}, timeoutMs);

		debugLog(`[isAstroWebsite] Fetching URL: ${url}`);
		response = await fetch(url, {
			signal,
			redirect: "manual",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept: "text/html",
				"Accept-Language": "en-US,en;q=0.5",
			},
		});

		// Handle error status codes first
		if (response.status >= 400) {
			throw new CustomError(
				`Server responded with status: ${String(response.status)}`,
				originalUrl,
				response.url,
			);
		}

		const setCookieHeader = response.headers.get("set-cookie");
		const cookies = setCookieHeader
			? setCookieHeader
					.split(",")
					.map((cookie) => cookie.trim().split(";")[0])
					.filter(Boolean)
			: [];

		debugLog(`[isAstroWebsite] Collected cookies: ${cookies.join(", ")}`);

		// this is to work around an infinite redirect pattern I saw on a site
		if (response.status >= 300) {
			debugLog(`[isAstroWebsite] Making second request with collected cookies`);
			clearTimeout(timeoutId);
			timeoutId = setTimeout(() => {
				controller.abort();
			}, timeoutMs);

			response = await fetch(url, {
				signal,
				redirect: "follow",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					Accept: "text/html",
					"Accept-Language": "en-US,en;q=0.5",
					Cookie: cookies.join("; "),
				},
			});
		}
		clearTimeout(timeoutId);

		const contentType = response.headers.get("content-type");
		if (contentType && !contentType.includes("text/html")) {
			debugLog(`[isAstroWebsite] Invalid content type: ${contentType}`);
			throw new CustomError("Invalid content type", originalUrl, response.url);
		}
		if (!response.body) {
			throw new CustomError(
				`Received response without body (status: ${response.status.toString()})`,
				originalUrl,
				response.url,
			);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		let headHtml = "";
		let bodyHtml = "";
		let readingHead = true;
		let chunkCount = 0;

		debugLog("[isAstroWebsite] Streaming response; starting to read chunks.");

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				debugLog("[isAstroWebsite] reader done");
				break;
			}

			chunkCount++;
			totalBytes += value.length;
			const chunk = decoder.decode(value, { stream: true });
			debugLog(
				`[isAstroWebsite] Reading chunk #${String(chunkCount)}, size=${String(value.length)}`,
			);

			const redirectUrl = checkMetaRefresh(chunk, metaRefreshRegex, response.url, debugLog);
			if (redirectUrl && currentRedirect < maxRedirects) {
				debugLog(`[isAstroWebsite] Found redirect to: ${redirectUrl}`);
				await reader.cancel();
				return await isAstroWebsite(
					redirectUrl,
					debug,
					currentRedirect + 1,
					maxRedirects,
					originalUrl,
				);
			}

			if (chunkCount < 4 && isBotChallenge(chunk)) {
				debugLog("[isAstroWebsite] Detected bot challenge page");
				await reader.cancel();
				throw new CustomError("Bot challenge detected", originalUrl, response.url);
			}

			if (readingHead) {
				headHtml += chunk;

				const foundGeneratorTag = parseGeneratorTags(
					headHtml,
					metaGeneratorRegex,
					debugLog,
					astroVersionRef,
					starlightVersionRef,
				);

				if (foundGeneratorTag) {
					const hasAstro = astroVersionRef.value;
					const hasStarlight = starlightVersionRef.value;

					if (hasAstro || hasStarlight) {
						debugLog("[isAstroWebsite] Found generator tag(s)");
						await reader.cancel();
						return {
							url: originalUrl,
							lastFetchedUrl: response.url,
							isAstro: true,
							mechanism: "Found generator meta tag",
							...(hasAstro && { astroVersion: astroVersionRef.value }),
							...(hasStarlight && { starlightVersion: starlightVersionRef.value }),
						};
					}
				}

				const headMarkers = getAstroHeadMarkers(
					headHtml,
					astroDataAttrRegex,
					astroAssetRegex,
					styleWhereRegex,
					styleAttrRegex,
					debugLog,
					"HEAD_PROGRESSIVE",
				);

				const endHeadMatch = endOfHeadRegex.exec(headHtml);
				if (endHeadMatch) {
					debugLog("[isAstroWebsite] Found </head>");
					const indexEnd = endHeadMatch.index + endHeadMatch[0].length;
					const leftoverBody = headHtml.slice(indexEnd);
					headHtml = headHtml.slice(0, indexEnd);

					if (headMarkers.length > 0) {
						debugLog(`[isAstroWebsite] Astro markers found in head: ${headMarkers.join(", ")}`);
						await reader.cancel();
						return {
							url: originalUrl,
							lastFetchedUrl: response.url,
							isAstro: true,
							mechanism: `Found ${new Intl.ListFormat("en").format(headMarkers)}`,
						};
					}

					readingHead = false;
					bodyHtml = leftoverBody;
				}
			} else {
				bodyHtml += chunk;

				const bodyMarkers = getAstroBodyMarkers(
					bodyHtml,
					astroDataAttrRegex,
					astroClassRegex,
					astroAssetRegex,
					astroIslandRegex,
					debugLog,
					"BODY_PROGRESSIVE",
				);
				if (bodyMarkers.length > 0) {
					debugLog(`[isAstroWebsite] Astro markers found so far: ${bodyMarkers.join(", ")}`);
					await reader.cancel();
					return {
						url: originalUrl,
						lastFetchedUrl: response.url,
						isAstro: true,
						mechanism: `Found ${new Intl.ListFormat("en").format(bodyMarkers)}`,
					};
				}
			}
		}

		// maybe there was never a head tag or they never closed it
		// readingHead probably isnt best variable name but idk
		if (readingHead) {
			debugLog("[isAstroWebsite] head never fully closed");
			const foundGeneratorTag = parseGeneratorTags(
				headHtml,
				metaGeneratorRegex,
				debugLog,
				astroVersionRef,
				starlightVersionRef,
			);
			if (foundGeneratorTag) {
				if (astroVersionRef.value && starlightVersionRef.value) {
					return {
						url: originalUrl,
						lastFetchedUrl: response.url,
						isAstro: true,
						mechanism: "Found generator meta tag",
						astroVersion: astroVersionRef.value,
						starlightVersion: starlightVersionRef.value,
					};
				}
				if (astroVersionRef.value) {
					return {
						url: originalUrl,
						lastFetchedUrl: response.url,
						isAstro: true,
						mechanism: "Found generator meta tag",
						astroVersion: astroVersionRef.value,
					};
				}
				if (starlightVersionRef.value) {
					return {
						url: originalUrl,
						lastFetchedUrl: response.url,
						isAstro: true,
						mechanism: "Found generator meta tag",
						starlightVersion: starlightVersionRef.value,
					};
				}
			}

			const headMarkers = getAllAstroMarkers(
				headHtml,
				astroDataAttrRegex,
				astroClassRegex,
				astroAssetRegex,
				astroIslandRegex,
				styleWhereRegex,
				styleAttrRegex,
				debugLog,
				"NO_HEAD_END",
			);
			if (headMarkers.length > 0) {
				debugLog(`[isAstroWebsite] Astro markers found: ${headMarkers.join(", ")}`);
				return {
					url: originalUrl,
					lastFetchedUrl: response.url,
					isAstro: true,
					mechanism: `Found ${new Intl.ListFormat("en").format(headMarkers)}`,
				};
			}

			debugLog("[isAstroWebsite] No Astro indicators found");
			return {
				url: originalUrl,
				lastFetchedUrl: response.url,
				isAstro: false,
				mechanism: "No Astro indicators found",
			};
		}

		debugLog("[isAstroWebsite] End of stream");
		return {
			url: originalUrl,
			lastFetchedUrl: response.url,
			isAstro: false,
			mechanism: "No Astro indicators found",
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new CustomError("Request timed out", originalUrl, response?.url);
		}
		debugLog("[isAstroWebsite] error thrown:", error);
		throw error;
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		if (debug) {
			const endTime = Date.now();
			const timeMs = endTime - startTime;
			debugLog(
				`[isAstroWebsite] Finished. Total time: ${String(timeMs)}ms, total bytes: ${String(totalBytes)}`,
			);
		}
	}
}
