import { readTextWithLimit } from "@lib/check/read-text";
import { cached, type TtlCache } from "@lib/check/ttl-cache";

export type ShowcaseSite = { title: string; url: string; slug: string };
export type ShowcaseStatus = { listed: false } | { listed: true; title: string; url: string };

const ASTRO_SHOWCASE_URL = "https://astro.build/api/showcase.json";
const STARLIGHT_SHOWCASE_URL =
	"https://raw.githubusercontent.com/withastro/starlight/main/docs/src/components/showcase-sites.astro";
const DAY_MS = 24 * 60 * 60_000;
const astroCache: TtlCache<ShowcaseSite[]> = new Map();
const starlightCache: TtlCache<{ title: string; url: string }[]> = new Map();

export function getShowcaseSites(
	fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ShowcaseSite[]> {
	return cached(astroCache, "sites", DAY_MS, async () => {
		const value: unknown = JSON.parse(await fetchListing(ASTRO_SHOWCASE_URL, 2_000_000, fetch));
		const sites = Array.isArray(value) ? value.filter(isShowcaseSite) : [];
		if (sites.length === 0) throw new Error("Astro showcase response contained no sites");
		return sites;
	});
}

export function getStarlightShowcaseSites(fetch: typeof globalThis.fetch = globalThis.fetch) {
	return cached(starlightCache, "sites", DAY_MS, async () => {
		const sites = parseStarlightShowcase(
			await fetchListing(STARLIGHT_SHOWCASE_URL, 500_000, fetch),
		);
		if (sites.length === 0) throw new Error("Starlight showcase source contained no sites");
		return sites;
	});
}

/** Starlight's showcase is an Astro component of <Card title href /> tags. */
export function parseStarlightShowcase(source: string): { title: string; url: string }[] {
	return [...source.matchAll(/<Card\b[\s\S]*?\/>/g)].flatMap(([tag]) => {
		const title = /\btitle=(['"])(.*?)\1/s.exec(tag)?.[2];
		const url = /\bhref=(['"])(.*?)\1/s.exec(tag)?.[2];
		return title && url && parseHttpUrl(url) ? [{ title, url }] : [];
	});
}

/** Finds the listing for `target`, which must be the final URL (never a pre-redirect one). */
export function findListing(
	target: string,
	sites: readonly { title: string; url: string }[],
): ShowcaseStatus {
	const match = sites.find((site) => isSameSite(target, site.url));
	return match ? { listed: true, title: match.title, url: match.url } : { listed: false };
}

/**
 * Hostnames match ignoring "www.". A listing with a path only covers that path,
 * and on github.io the first path segment identifies the project.
 */
function isSameSite(target: string, listing: string): boolean {
	const targetUrl = parseHttpUrl(target);
	const listingUrl = parseHttpUrl(listing);
	if (!targetUrl || targetUrl.hostname !== listingUrl?.hostname) return false;
	const targetPath = targetUrl.pathname.toLowerCase();
	const listingPath = listingUrl.pathname.toLowerCase();
	if (targetUrl.hostname.endsWith(".github.io")) {
		return targetPath.split("/")[1] === listingPath.split("/")[1];
	}
	return (
		listingPath === "/" || targetPath === listingPath || targetPath.startsWith(`${listingPath}/`)
	);
}

function parseHttpUrl(value: string): URL | undefined {
	const url = URL.canParse(value) ? new URL(value) : undefined;
	if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname)
		return undefined;
	url.hostname = url.hostname
		.toLowerCase()
		.replace(/^www\./, "")
		.replace(/\.$/, "");
	url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
	return url;
}

async function fetchListing(
	url: string,
	maxBytes: number,
	fetch: typeof globalThis.fetch,
): Promise<string> {
	const init: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
		signal: AbortSignal.timeout(3_000),
		cf: { cacheEverything: true, cacheTtl: 86_400 },
	};
	const response = await fetch(url, init);
	if (!response.ok) throw new Error(`${url} returned ${String(response.status)}`);
	return readTextWithLimit(response, maxBytes);
}

function isShowcaseSite(value: unknown): value is ShowcaseSite {
	return (
		typeof value === "object" &&
		value !== null &&
		"title" in value &&
		typeof value.title === "string" &&
		"slug" in value &&
		typeof value.slug === "string" &&
		"url" in value &&
		typeof value.url === "string" &&
		parseHttpUrl(value.url) !== undefined
	);
}
