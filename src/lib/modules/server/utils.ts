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

export function getAllAstroMarkers(
	fragment: string,
	astroDataAttr: RegExp,
	astroClassRegex: RegExp,
	astroAssetRegex: RegExp,
	astroIslandRegex: RegExp,
	styleWhereRegex: RegExp,
	styleAttrRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	phaseLabel: string,
) {
	const markers: string[] = [];

	if (astroDataAttr.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "data-astro-" in: "${fragment.slice(0, 200)}"`);
		markers.push("data-astro- attribute");
	}
	if (astroClassRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "astro- in class" in: "${fragment.slice(0, 200)}"`);
		markers.push("astro- class");
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
		debugLog(`[${phaseLabel}] Found "[data-astro-...]" in: "${fragment.slice(0, 200)}"`);
		markers.push("data-astro- css usage");
	}
	if (astroIslandRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "astro-island" in: "${fragment.slice(0, 200)}"`);
		markers.push("astro-island css usage");
	}

	return markers;
}

export function getAstroHeadMarkers(
	fragment: string,
	astroDataAttr: RegExp,
	astroAssetRegex: RegExp,
	styleWhereRegex: RegExp,
	styleAttrRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	phaseLabel: string,
) {
	const markers: string[] = [];

	if (astroDataAttr.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "data-astro- " in: "${fragment.slice(0, 200)}"`);
		markers.push("data-astro- attribute");
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
		debugLog(`[${phaseLabel}] Found "[data-astro-...]" in: "${fragment.slice(0, 200)}"`);
		markers.push("data-astro- css usage");
	}

	return markers;
}

export function getAstroBodyMarkers(
	fragment: string,
	astroDataAttr: RegExp,
	astroClassRegex: RegExp,
	astroAssetRegex: RegExp,
	astroIslandRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	phaseLabel: string,
) {
	const markers: string[] = [];

	if (astroDataAttr.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "data-astro-" in: "${fragment.slice(0, 200)}"`);
		markers.push("data-astro- attribute");
	}
	if (astroClassRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "astro- in class" in: "${fragment.slice(0, 200)}"`);
		markers.push("astro- class");
	}
	if (astroAssetRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "_astro/ asset reference" in: "${fragment.slice(0, 200)}"`);
		markers.push("_astro/ asset reference");
	}
	if (astroIslandRegex.test(fragment)) {
		debugLog(`[${phaseLabel}] Found "astro-island" in: "${fragment.slice(0, 200)}"`);
		markers.push("astro-island css usage");
	}

	return markers;
}

/** Returns the redirect URL if found. */
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

export function isBotChallenge(html: string): boolean {
	const indicators = [
		// /<title>Just a moment\.\.\.<\/title>/i,
		/cdn-cgi\/challenge-platform/i,
		/_cf_chl_opt/i,
		/cf-spinner/i,
		/\.well-known\/sgcaptcha/i,
		/<meta[^>]+refresh[^>]+sgcaptcha/i,
		/<meta[^>]+refresh[^>]+challenge/i,
		/<meta[^>]+refresh[^>]+verify/i,
	];

	return indicators.some((indicator) => indicator.test(html));
}

export class CustomError extends Error {
	constructor(
		message: string,
		public readonly originalUrl: string,
		public readonly lastFetchedUrl?: string,
	) {
		super(message);
		this.name = "CustomError";
	}
}

export const metaGeneratorRegex = /<meta[^>]*\bgenerator\b[^>]*content\s*=\s*["']([^"']+)["']/gi;
export const metaRefreshRegex =
	/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*([^"']+)["']/i;
export const astroDataAttrRegex = /data-astro-[a-zA-Z0-9-]+/i;
export const astroIslandRegex = /<astro-island\b/i;
export const astroClassRegex = /class\s*=\s*["'][^"']*astro-/i;
export const astroAssetRegex =
	/<(script|link|img|picture|meta[^>]*property\s*=\s*["']og:image["'])[^>]*_astro\//i;
export const endOfHeadRegex = /<\/head>/i;
export const styleWhereRegex = /:where\s*\(\.astro-[\w-]+\)/i;
export const styleAttrRegex = /\[data-astro-[^\]]*\]/i;
