import {
	addProtocolToUrlAndTrim,
	astroAssetRegex,
	astroClassRegex,
	astroDataAttrRegex,
	astroIslandRegex,
	checkMetaRefresh,
	consumeHtmlTags,
	CustomError,
	endOfHeadRegex,
	getAllAstroMarkers,
	getAstroBodyMarkers,
	getAstroHeadMarkers,
	isBotChallenge,
	isValidUrl,
	metaRefreshRegex,
	parseGeneratorMetaTag,
	styleAttrRegex,
	styleWhereRegex,
} from "./utils";

export { addProtocolToUrlAndTrim, CustomError, isValidUrl };

export const DEFAULT_DETECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_CACHE_MAX_ENTRIES = 256;

const MARKER_SCAN_BATCH_SIZE = 8_192;
const MARKER_SCAN_OVERLAP = 512;
const HEAD_BOUNDARY_OVERLAP = 16;
const MAX_INCOMPLETE_TAG_LENGTH = 16_384;
const BOT_CHALLENGE_SCAN_LIMIT = 65_536;

export type DetectionResult = {
	url: string;
	lastFetchedUrl: string;
	isAstro: boolean;
	isStarlight: boolean;
	mechanism: string;
	astroVersion?: string;
	starlightVersion?: string;
};

export type DetectionOptions = {
	debug?: boolean;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
	fetch?: typeof globalThis.fetch;
};

export type CachedDetectionOptions = {
	cacheTtlMs?: number;
	cacheMaxEntries?: number;
} & DetectionOptions;

type GeneratorState = {
	astro: boolean;
	starlight: boolean;
	astroVersion?: string;
	starlightVersion?: string;
};

type MarkerScanner = {
	pending: string;
	markers: Set<string>;
};

type CacheEntry = {
	expiresAt: number;
	result: DetectionResult;
};

const detectionCache = new Map<string, CacheEntry>();
const inFlightDetections = new Map<string, Promise<DetectionResult>>();

function positiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new TypeError("Limit must be a positive number");
	return Math.floor(value);
}

function redirectLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_REDIRECTS;
	if (!Number.isFinite(value) || value < 0)
		throw new TypeError("maxRedirects must not be negative");
	return Math.floor(value);
}

function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	void reader.cancel().catch(() => undefined);
}

function detectionResult(
	originalUrl: string,
	lastFetchedUrl: string,
	isAstro: boolean,
	mechanism: string,
	generator?: GeneratorState,
): DetectionResult {
	return {
		url: originalUrl,
		lastFetchedUrl,
		isAstro,
		isStarlight: generator?.starlight ?? false,
		mechanism,
		...(generator?.astroVersion && { astroVersion: generator.astroVersion }),
		...(generator?.starlightVersion && { starlightVersion: generator.starlightVersion }),
	};
}

function markerResult(
	originalUrl: string,
	lastFetchedUrl: string,
	markers: Set<string>,
): DetectionResult {
	return detectionResult(
		originalUrl,
		lastFetchedUrl,
		true,
		`Found ${new Intl.ListFormat("en").format([...markers])}`,
	);
}

function generatorResult(
	originalUrl: string,
	lastFetchedUrl: string,
	generator: GeneratorState,
): DetectionResult {
	return detectionResult(originalUrl, lastFetchedUrl, true, "Found generator meta tag", generator);
}

function ensureValidTarget(value: string, originalUrl: string, lastFetchedUrl?: string): URL {
	if (!isValidUrl(value)) {
		throw new CustomError("Invalid or disallowed URL", originalUrl, lastFetchedUrl ?? value);
	}
	return new URL(value);
}

function resolveRedirect(
	location: string,
	baseUrl: URL,
	originalUrl: string,
	redirectsFollowed: number,
	maxRedirects: number,
): URL {
	if (redirectsFollowed >= maxRedirects) {
		throw new CustomError("Too many redirects", originalUrl, baseUrl.toString());
	}
	let resolved: URL;
	try {
		resolved = new URL(location, baseUrl);
	} catch {
		throw new CustomError("Invalid redirect URL", originalUrl, baseUrl.toString());
	}
	return ensureValidTarget(resolved.toString(), originalUrl, baseUrl.toString());
}

function addMarkers(target: Set<string>, markers: string[]): void {
	for (const marker of markers) target.add(marker);
}

function scanMarkers(
	scanner: MarkerScanner,
	text: string,
	force: boolean,
	detect: (fragment: string) => string[],
): void {
	scanner.pending += text;
	if (!force && scanner.pending.length < MARKER_SCAN_BATCH_SIZE) return;
	addMarkers(scanner.markers, detect(scanner.pending));
	if (force) {
		scanner.pending = "";
	} else {
		scanner.pending = scanner.pending.slice(-MARKER_SCAN_OVERLAP);
	}
}

function trimIncompleteTag(remainder: string): string {
	if (remainder.length <= MAX_INCOMPLETE_TAG_LENGTH) return remainder;
	const laterTag = remainder.lastIndexOf("<");
	if (laterTag > 0 && remainder.length - laterTag <= MAX_INCOMPLETE_TAG_LENGTH) {
		return remainder.slice(laterTag);
	}
	return "";
}

function isHtmlContentType(contentType: string | null): boolean {
	if (!contentType) return true;
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase();
	return mimeType === "text/html" || mimeType === "application/xhtml+xml";
}

function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400;
}

/**
 * Detects Astro from an uncached request. Pass an options object to make the
 * request limits and fetch implementation explicit in tests or other runtimes.
 */
export function isAstroWebsite(
	url: string | URL,
	options?: DetectionOptions,
): Promise<DetectionResult>;
export function isAstroWebsite(
	url: string | URL,
	debug?: boolean,
	currentRedirect?: number,
	maxRedirects?: number,
	originalUrl?: string,
): Promise<DetectionResult>;
export async function isAstroWebsite(
	url: string | URL,
	debugOrOptions: boolean | DetectionOptions = false,
	currentRedirect = 0,
	legacyMaxRedirects = DEFAULT_MAX_REDIRECTS,
	legacyOriginalUrl?: string,
): Promise<DetectionResult> {
	const options: DetectionOptions =
		typeof debugOrOptions === "boolean"
			? { debug: debugOrOptions, maxRedirects: legacyMaxRedirects }
			: debugOrOptions;
	const debug = options.debug ?? false;
	const debugLog: (...args: unknown[]) => void = debug ? console.log : () => undefined;
	const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_DETECTION_TIMEOUT_MS);
	const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_RESPONSE_BYTES);
	const maxRedirects = redirectLimit(options.maxRedirects);
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const originalUrl = legacyOriginalUrl ?? url.toString();
	let target = ensureValidTarget(url.toString(), originalUrl);
	let redirectsFollowed = typeof debugOrOptions === "boolean" ? currentRedirect : 0;
	let totalBytes = 0;
	let lastFetchedUrl = target.toString();
	let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const startedAt = Date.now();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		for (;;) {
			lastFetchedUrl = target.toString();
			debugLog(`[isAstroWebsite] Fetching ${lastFetchedUrl}`);
			const response = await withAbort(
				fetchImplementation(target, {
					signal: controller.signal,
					redirect: "manual",
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
						Accept: "text/html,application/xhtml+xml",
						"Accept-Language": "en-US,en;q=0.5",
					},
				}),
				controller.signal,
			);

			if (isRedirectStatus(response.status)) {
				const location = response.headers.get("location");
				if (!location) {
					throw new CustomError(
						`Redirect response (${String(response.status)}) did not include a Location header`,
						originalUrl,
						lastFetchedUrl,
					);
				}
				target = resolveRedirect(location, target, originalUrl, redirectsFollowed, maxRedirects);
				redirectsFollowed++;
				continue;
			}

			if (!response.ok) {
				throw new CustomError(
					`Server responded with status: ${String(response.status)}`,
					originalUrl,
					lastFetchedUrl,
				);
			}
			if (!isHtmlContentType(response.headers.get("content-type"))) {
				throw new CustomError("Invalid content type", originalUrl, lastFetchedUrl);
			}
			if (!response.body) {
				throw new CustomError(
					`Received response without body (status: ${String(response.status)})`,
					originalUrl,
					lastFetchedUrl,
				);
			}

			const contentLength = Number(response.headers.get("content-length"));
			if (Number.isFinite(contentLength) && contentLength > maxBytes - totalBytes) {
				throw new CustomError(
					`Response exceeded the ${String(maxBytes)} byte limit`,
					originalUrl,
					lastFetchedUrl,
				);
			}

			const generator: GeneratorState = { astro: false, starlight: false };
			const headScanner: MarkerScanner = { pending: "", markers: new Set() };
			const bodyScanner: MarkerScanner = { pending: "", markers: new Set() };
			const unclosedHeadScanner: MarkerScanner = { pending: "", markers: new Set() };
			const decoder = new TextDecoder();
			let tagBuffer = "";
			let phaseBuffer = "";
			let challengeBuffer = "";
			let readingHead = true;
			let metaRedirect: string | undefined;
			let completedResult: DetectionResult | undefined;

			const headDetector = (fragment: string) =>
				getAstroHeadMarkers(
					fragment,
					astroDataAttrRegex,
					astroAssetRegex,
					styleWhereRegex,
					styleAttrRegex,
					debugLog,
					"HEAD",
				);
			const bodyDetector = (fragment: string) =>
				getAstroBodyMarkers(
					fragment,
					astroDataAttrRegex,
					astroClassRegex,
					astroAssetRegex,
					astroIslandRegex,
					debugLog,
					"BODY",
				);
			const fallbackDetector = (fragment: string) =>
				getAllAstroMarkers(
					fragment,
					astroDataAttrRegex,
					astroClassRegex,
					astroAssetRegex,
					astroIslandRegex,
					styleWhereRegex,
					styleAttrRegex,
					debugLog,
					"NO_HEAD_END",
				);

			const processText = (text: string): void => {
				if (!text || metaRedirect || completedResult) return;

				if (totalBytes <= BOT_CHALLENGE_SCAN_LIMIT) {
					challengeBuffer = (challengeBuffer + text).slice(-MARKER_SCAN_BATCH_SIZE);
					if (isBotChallenge(challengeBuffer)) {
						throw new CustomError("Bot challenge detected", originalUrl, lastFetchedUrl);
					}
				}

				tagBuffer += text;
				const consumed = consumeHtmlTags(tagBuffer);
				tagBuffer = trimIncompleteTag(consumed.remainder);
				for (const tag of consumed.tags) {
					const foundGenerator = parseGeneratorMetaTag(tag);
					if (readingHead && foundGenerator?.astro) {
						generator.astro = true;
						if (foundGenerator.astroVersion) {
							generator.astroVersion ??= foundGenerator.astroVersion;
						}
					}
					if (readingHead && foundGenerator?.starlight) {
						generator.starlight = true;
						if (foundGenerator.starlightVersion) {
							generator.starlightVersion ??= foundGenerator.starlightVersion;
						}
					}
					const redirect = checkMetaRefresh(tag, metaRefreshRegex, target.toString(), debugLog);
					if (redirect) {
						metaRedirect = redirect;
						return;
					}
				}

				if (!readingHead) {
					scanMarkers(bodyScanner, text, false, bodyDetector);
					if (bodyScanner.markers.size > 0) {
						completedResult = markerResult(originalUrl, lastFetchedUrl, bodyScanner.markers);
					}
					return;
				}

				phaseBuffer += text;
				endOfHeadRegex.lastIndex = 0;
				const endOfHead = endOfHeadRegex.exec(phaseBuffer);
				if (endOfHead) {
					const boundary = endOfHead.index + endOfHead[0].length;
					const headText = phaseBuffer.slice(0, boundary);
					const bodyText = phaseBuffer.slice(boundary);
					scanMarkers(headScanner, headText, true, headDetector);
					readingHead = false;
					phaseBuffer = "";
					if (generator.astro || generator.starlight) {
						completedResult = generatorResult(originalUrl, lastFetchedUrl, generator);
						return;
					}
					if (headScanner.markers.size > 0) {
						completedResult = markerResult(originalUrl, lastFetchedUrl, headScanner.markers);
						return;
					}
					scanMarkers(bodyScanner, bodyText, false, bodyDetector);
					if (bodyScanner.markers.size > 0) {
						completedResult = markerResult(originalUrl, lastFetchedUrl, bodyScanner.markers);
					}
					return;
				}

				if (phaseBuffer.length > HEAD_BOUNDARY_OVERLAP) {
					const flushLength = phaseBuffer.length - HEAD_BOUNDARY_OVERLAP;
					const headText = phaseBuffer.slice(0, flushLength);
					phaseBuffer = phaseBuffer.slice(flushLength);
					scanMarkers(headScanner, headText, false, headDetector);
					scanMarkers(unclosedHeadScanner, headText, false, fallbackDetector);
				}
			};

			activeReader = response.body.getReader();
			while (!metaRedirect && !completedResult) {
				const { done, value } = await withAbort(activeReader.read(), controller.signal);
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > maxBytes) {
					throw new CustomError(
						`Response exceeded the ${String(maxBytes)} byte limit`,
						originalUrl,
						lastFetchedUrl,
					);
				}
				processText(decoder.decode(value, { stream: true }));
			}

			if (!metaRedirect && !completedResult) processText(decoder.decode());
			if (metaRedirect || completedResult) cancelReader(activeReader);
			activeReader = undefined;

			if (metaRedirect) {
				target = resolveRedirect(
					metaRedirect,
					target,
					originalUrl,
					redirectsFollowed,
					maxRedirects,
				);
				redirectsFollowed++;
				continue;
			}
			if (completedResult) return completedResult;

			// The stream callback updates this state when it crosses </head>.
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (readingHead) {
				scanMarkers(headScanner, phaseBuffer, true, headDetector);
				scanMarkers(unclosedHeadScanner, phaseBuffer, true, fallbackDetector);
				if (generator.astro || generator.starlight) {
					return generatorResult(originalUrl, lastFetchedUrl, generator);
				}
				if (unclosedHeadScanner.markers.size > 0) {
					return markerResult(originalUrl, lastFetchedUrl, unclosedHeadScanner.markers);
				}
			} else {
				scanMarkers(bodyScanner, "", true, bodyDetector);
				if (bodyScanner.markers.size > 0) {
					return markerResult(originalUrl, lastFetchedUrl, bodyScanner.markers);
				}
			}

			return detectionResult(originalUrl, lastFetchedUrl, false, "No Astro indicators found");
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new CustomError("Request timed out", originalUrl, lastFetchedUrl);
		}
		debugLog("[isAstroWebsite] Error:", error);
		throw error;
	} finally {
		clearTimeout(timeoutId);
		if (activeReader) cancelReader(activeReader);
		debugLog(
			`[isAstroWebsite] Finished in ${String(Date.now() - startedAt)}ms after ${String(totalBytes)} bytes`,
		);
	}
}

function cacheKey(url: string | URL, options: DetectionOptions): string {
	let normalized = url.toString();
	try {
		normalized = new URL(normalized).toString();
	} catch {
		// The uncached detector will return the detailed validation error.
	}
	return [
		normalized,
		options.timeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS,
		options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
		options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
	].join("|");
}

function pruneCache(now: number, maxEntries: number): void {
	for (const [key, entry] of detectionCache) {
		if (entry.expiresAt <= now) detectionCache.delete(key);
	}
	while (detectionCache.size >= maxEntries) {
		const oldestKey = detectionCache.keys().next().value;
		if (!oldestKey) break;
		detectionCache.delete(oldestKey);
	}
}

/** Bounded TTL cache with concurrent request coalescing for route handlers. */
export function getCachedAstroDetection(
	url: string | URL,
	options: CachedDetectionOptions = {},
): Promise<DetectionResult> {
	const { cacheTtlMs = DEFAULT_CACHE_TTL_MS, cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES } =
		options;
	const ttlMs = Math.max(0, Math.floor(cacheTtlMs));
	const maxEntries = Math.max(1, Math.floor(cacheMaxEntries));
	const key = cacheKey(url, options);
	const now = Date.now();
	const cached = detectionCache.get(key);
	if (cached && cached.expiresAt > now) return Promise.resolve(cached.result);
	if (cached) detectionCache.delete(key);
	const existing = inFlightDetections.get(key);
	if (existing) return existing;

	const request = isAstroWebsite(url, options)
		.then((result) => {
			if (ttlMs > 0) {
				pruneCache(Date.now(), maxEntries);
				detectionCache.set(key, { expiresAt: Date.now() + ttlMs, result });
			}
			return result;
		})
		.finally(() => inFlightDetections.delete(key));
	inFlightDetections.set(key, request);
	return request;
}

export const isAstroWebsiteCached = getCachedAstroDetection;

export function clearDetectionCache(): void {
	detectionCache.clear();
	inFlightDetections.clear();
}
