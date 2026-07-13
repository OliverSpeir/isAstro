export type GeneratorDetection = {
	astro: boolean;
	starlight: boolean;
	astroVersion?: string;
	starlightVersion?: string;
};

type ParsedMetaTag = {
	name: string | undefined;
	content: string | undefined;
	httpEquiv: string | undefined;
};

const HTML_ATTRIBUTE_REGEX = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Extracts complete HTML tags and retains only the final incomplete tag. */
export function consumeHtmlTags(fragment: string): { tags: string[]; remainder: string } {
	const tags: string[] = [];
	let cursor = 0;

	while (cursor < fragment.length) {
		const start = fragment.indexOf("<", cursor);
		if (start === -1) {
			return { tags, remainder: "" };
		}

		let quote: '"' | "'" | undefined;
		let complete = false;
		for (let index = start + 1; index < fragment.length; index++) {
			const character = fragment[index];
			if (quote) {
				if (character === quote) quote = undefined;
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				continue;
			}
			if (character === ">") {
				tags.push(fragment.slice(start, index + 1));
				cursor = index + 1;
				complete = true;
				break;
			}
		}

		if (!complete) return { tags, remainder: fragment.slice(start) };
	}

	return { tags, remainder: "" };
}

function parseMetaTag(tag: string): ParsedMetaTag | undefined {
	const opening = /^<\s*meta(?:\s|\/?>)/i.exec(tag);
	if (!opening) return undefined;

	const attributes: Record<string, string> = {};
	HTML_ATTRIBUTE_REGEX.lastIndex = opening[0].length;
	let match: RegExpExecArray | null;
	while ((match = HTML_ATTRIBUTE_REGEX.exec(tag)) !== null) {
		const name = match[1]?.toLowerCase();
		if (!name || name === "/") continue;
		attributes[name] = match[2] ?? match[3] ?? match[4] ?? "";
	}

	return {
		name: attributes.name,
		content: attributes.content,
		httpEquiv: attributes["http-equiv"],
	};
}

/** Parses one complete meta tag without depending on attribute order. */
export function parseGeneratorMetaTag(tag: string): GeneratorDetection | undefined {
	const meta = parseMetaTag(tag);
	if (meta?.name?.trim().toLowerCase() !== "generator" || meta.content === undefined) {
		return undefined;
	}

	const content = meta.content.trim();
	const match = /^(Astro|Starlight)(?:\s+(.+))?$/i.exec(content);
	if (!match?.[1]) return undefined;

	const version = match[2]?.trim();
	if (match[1].toLowerCase() === "astro") {
		return { astro: true, starlight: false, ...(version && { astroVersion: version }) };
	}
	return {
		astro: false,
		starlight: true,
		...(version && { starlightVersion: version }),
	};
}

/**
 * Backwards-compatible fragment parser. The `detected` flag distinguishes a
 * versionless generator from no generator at all.
 */
export function parseGeneratorTags(
	fragment: string,
	_metaGeneratorRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	astroVersionRef: { value?: string; detected?: boolean },
	starlightVersionRef: { value?: string; detected?: boolean },
): boolean {
	let foundGenerator = false;
	const { tags } = consumeHtmlTags(fragment);
	for (const tag of tags) {
		const detection = parseGeneratorMetaTag(tag);
		if (!detection) continue;
		foundGenerator = true;
		if (detection.astro) {
			astroVersionRef.detected = true;
			if (detection.astroVersion) astroVersionRef.value ??= detection.astroVersion;
			debugLog(
				`[parseGeneratorTags] Found Astro generator${detection.astroVersion ? ` ${detection.astroVersion}` : ""}`,
			);
		}
		if (detection.starlight) {
			starlightVersionRef.detected = true;
			if (detection.starlightVersion) {
				starlightVersionRef.value ??= detection.starlightVersion;
			}
			debugLog(
				`[parseGeneratorTags] Found Starlight generator${detection.starlightVersion ? ` ${detection.starlightVersion}` : ""}`,
			);
		}
	}
	return foundGenerator;
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
): string[] {
	return collectMarkers(
		fragment,
		[
			[astroDataAttr, "data-astro- attribute"],
			[astroClassRegex, "astro- class"],
			[astroAssetRegex, "_astro/ asset reference"],
			[styleWhereRegex, ":where(.astro-...) usage"],
			[styleAttrRegex, "data-astro- css usage"],
			[astroIslandRegex, "astro-island usage"],
		],
		debugLog,
		phaseLabel,
	);
}

export function getAstroHeadMarkers(
	fragment: string,
	astroDataAttr: RegExp,
	astroAssetRegex: RegExp,
	styleWhereRegex: RegExp,
	styleAttrRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	phaseLabel: string,
): string[] {
	return collectMarkers(
		fragment,
		[
			[astroDataAttr, "data-astro- attribute"],
			[astroAssetRegex, "_astro/ asset reference"],
			[styleWhereRegex, ":where(.astro-...) usage"],
			[styleAttrRegex, "data-astro- css usage"],
		],
		debugLog,
		phaseLabel,
	);
}

export function getAstroBodyMarkers(
	fragment: string,
	astroDataAttr: RegExp,
	astroClassRegex: RegExp,
	astroAssetRegex: RegExp,
	astroIslandRegex: RegExp,
	debugLog: (...args: unknown[]) => void,
	phaseLabel: string,
): string[] {
	return collectMarkers(
		fragment,
		[
			[astroDataAttr, "data-astro- attribute"],
			[astroClassRegex, "astro- class"],
			[astroAssetRegex, "_astro/ asset reference"],
			[astroIslandRegex, "astro-island usage"],
		],
		debugLog,
		phaseLabel,
	);
}

function collectMarkers(
	fragment: string,
	checks: readonly (readonly [RegExp, string])[],
	debugLog: (...args: unknown[]) => void,
	phaseLabel: string,
): string[] {
	const markers: string[] = [];
	for (const [pattern, label] of checks) {
		pattern.lastIndex = 0;
		if (!pattern.test(fragment)) continue;
		debugLog(`[${phaseLabel}] Found ${label} in: "${fragment.slice(0, 200)}"`);
		markers.push(label);
	}
	return markers;
}

/** Returns the redirect URL if a complete meta-refresh tag is found. */
export function checkMetaRefresh(
	fragment: string,
	_metaRefreshRegex: RegExp,
	baseUrl: string,
	debugLog: (...args: unknown[]) => void,
): string | null {
	const { tags } = consumeHtmlTags(fragment);
	for (const tag of tags) {
		const meta = parseMetaTag(tag);
		if (meta?.httpEquiv?.trim().toLowerCase() !== "refresh" || !meta.content) continue;
		const match = /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.*?)\s*$/i.exec(meta.content);
		if (!match?.[1]) continue;
		const rawRedirectPath = match[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2").trim();
		if (!rawRedirectPath) continue;
		try {
			const redirectUrl = new URL(rawRedirectPath, baseUrl).toString();
			debugLog(`[checkMetaRefresh] Found meta refresh to: ${redirectUrl}`);
			return redirectUrl;
		} catch {
			return null;
		}
	}
	return null;
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
	const parts = hostname.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map(Number);
	if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return octets as [number, number, number, number];
}

function isDisallowedIpv4([first, second, third]: [number, number, number, number]): boolean {
	return (
		first === 0 ||
		first === 10 ||
		(first === 100 && second >= 64 && second <= 127) ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 0 && (third === 0 || third === 2)) ||
		(first === 192 && second === 88 && third === 99) ||
		(first === 192 && second === 168) ||
		(first === 198 && (second === 18 || second === 19)) ||
		(first === 198 && second === 51 && third === 100) ||
		(first === 203 && second === 0 && third === 113) ||
		first >= 224
	);
}

function parseIpv6(hostname: string): bigint | undefined {
	let host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host.includes("%")) return undefined;
	if (host.includes(".")) {
		const lastColon = host.lastIndexOf(":");
		const ipv4 = parseIpv4(host.slice(lastColon + 1));
		if (!ipv4) return undefined;
		host = `${host.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
	}

	const halves = host.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
	const groups = [...left, ...Array<string>(zeroCount).fill("0"), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
		return undefined;
	}
	return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isInIpv6Range(value: bigint, base: bigint, prefixLength: number): boolean {
	const shift = BigInt(128 - prefixLength);
	return value >> shift === base >> shift;
}

function isDisallowedIpv6(hostname: string): boolean {
	const value = parseIpv6(hostname);
	if (value === undefined) return true;
	const ranges: readonly (readonly [string, number])[] = [
		["::", 128],
		["::1", 128],
		["::ffff:0:0", 96],
		["64:ff9b::", 96],
		["100::", 64],
		["2001::", 23],
		["2001:db8::", 32],
		["2002::", 16],
		["fc00::", 7],
		["fe80::", 10],
		["ff00::", 8],
	];
	return ranges.some(([base, prefix]) => {
		const parsedBase = parseIpv6(base);
		return parsedBase !== undefined && isInIpv6Range(value, parsedBase, prefix);
	});
}

/** Validates an outbound target before every request. */
export function isValidUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (!url.hostname || url.username || url.password) return false;

	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		return false;
	}
	const ipv4 = parseIpv4(hostname);
	if (ipv4) return !isDisallowedIpv4(ipv4);
	if (hostname.includes(":")) return !isDisallowedIpv6(hostname);
	return hostname.includes(".");
}

export function addProtocolToUrlAndTrim(url: string): string {
	let formattedUrl = url.trim();
	if (!/^https?:\/\//i.test(formattedUrl)) formattedUrl = `https://${formattedUrl}`;
	return formattedUrl;
}

export function isBotChallenge(html: string): boolean {
	const indicators = [
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

// Retained as public constants for callers using the older helper signatures.
export const metaGeneratorRegex = /<meta\b[^>]*>/gi;
export const metaRefreshRegex = /<meta\b[^>]*>/gi;
export const astroDataAttrRegex = /data-astro-[a-zA-Z0-9-]+/i;
export const astroIslandRegex = /<astro-island\b/i;
export const astroClassRegex = /class\s*=\s*["'][^"']*astro-/i;
export const astroAssetRegex =
	/<(script|link|img|picture|meta[^>]*property\s*=\s*["']og:image["'])[^>]*_astro\//i;
export const endOfHeadRegex = /<\/head>/i;
export const styleWhereRegex = /:where\s*\(\.astro-[\w-]+\)/i;
export const styleAttrRegex = /\[data-astro-[^\]]*\]/i;
