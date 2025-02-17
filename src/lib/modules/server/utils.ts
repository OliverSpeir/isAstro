/** Parses the HTML fragment for any <meta generator="..."> tags.
 *  Updates astroVersion and starlightVersion if found.
 */
export function parseGeneratorTags(
	fragment: string,
	metaGeneratorRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	astroVersionRef: { value?: string },
	starlightVersionRef: { value?: string },
) {
	let foundAnyTag = false;
	let match;
	metaGeneratorRegex.lastIndex = 0;

	while ((match = metaGeneratorRegex.exec(fragment)) !== null && match[1]) {
		foundAnyTag = true;
		const content = match[1].trim();
		debugLog(`[parseGeneratorTags] Found generator meta tag content: "${content}"`);

		if (/^Astro\b/i.test(content)) {
			const ver = content.replace(/^Astro\s*/i, "").trim();
			if (!astroVersionRef.value && ver) {
				astroVersionRef.value = ver;
			}
		} else if (/^Starlight\b/i.test(content)) {
			const ver = content.replace(/^Starlight\s*/i, "").trim();
			if (!starlightVersionRef.value && ver) {
				starlightVersionRef.value = ver;
			}
		}
	}

	return foundAnyTag;
}

/** Checks for various Astro-related markers in an HTML fragment. */
export function getAstroMarkers(
	fragment: string,
	astroCidRegex: RegExp,
	astroClassRegex: RegExp,
	astroAssetRegex: RegExp,
	styleWhereRegex: RegExp,
	styleAttrRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	phaseLabel: string,
) {
	const markers: string[] = [];

	if (astroCidRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "data-astro-cid-" in: "${fragment.slice(0, 200)}"`);
		markers.push("data-astro-cid attribute");
	}
	if (astroClassRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "astro-cid in class" in: "${fragment.slice(0, 200)}"`);
		markers.push("astro-cid- class");
	}
	if (astroAssetRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "_astro/ asset reference" in: "${fragment.slice(0, 200)}"`);
		markers.push("_astro/ asset reference");
	}
	if (styleWhereRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found ":where(.astro-...)" in: "${fragment.slice(0, 200)}"`);
		markers.push(":where(.astro-...) usage");
	}
	if (styleAttrRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "[data-astro-cid-...]" in: "${fragment.slice(0, 200)}"`);
		markers.push("data-astro-cid- usage");
	}

	return markers;
}

/** Checks a chunk of HTML for a meta-refresh redirect. Returns the redirect URL if found. */
export function checkMetaRefresh(
	fragment: string,
	metaRefreshRegex: RegExp,
	baseUrl: string,
	debugLog: (...args: unknown[]) => void,
) {
	const match = metaRefreshRegex.exec(fragment);
	if (match?.[1]) {
		const rawRedirectPath = match[1].trim();
		debugLog(`[checkMetaRefresh] Found meta refresh to: ${rawRedirectPath}`);
		return new URL(rawRedirectPath, baseUrl).toString();
	}
	return null;
}

export function isValidUrl(url: string) {
	try {
		new URL(url);
	} catch {
		return false;
	}
	// this is from zod's url schema
	const urlRegex =
		/^(?:(?:(?:https?|ftp):)?\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5]))|(?:(?:[a-z0-9\u00a1-\uffff][a-z0-9\u00a1-\uffff_-]{0,62})?[a-z0-9\u00a1-\uffff]\.)+(?:[a-z\u00a1-\uffff]{2,}\.?))(?::\d{2,5})?(?:[/?#]\S*)?$/i;
	return urlRegex.test(url);
}

export function addProtocolToUrlAndTrim(url: string) {
	let formattedUrl = url.trim();
	if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://")) {
		// you're on your own if you want to check http://
		formattedUrl = `https://${formattedUrl}`;
	}
	return formattedUrl;
}
