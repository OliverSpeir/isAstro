import type { ShowcaseStatus } from "@lib/showcase";
import { readResponseTextWithLimit } from "@modules/server/response";

export const STARLIGHT_SHOWCASE_SOURCE_URL =
	"https://raw.githubusercontent.com/withastro/starlight/main/docs/src/components/showcase-sites.astro";

type StarlightShowcaseSite = {
	title: string;
	url: string;
};

const CACHE_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_SOURCE_BYTES = 500_000;

let cache: { expiresAt: number; sites: StarlightShowcaseSite[] } | undefined;
let inFlight: Promise<StarlightShowcaseSite[]> | undefined;

function normalizedUrl(value: string | URL): URL | undefined {
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
			return undefined;
		}
		url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
		return url;
	} catch {
		return undefined;
	}
}

function firstPathSegment(url: URL): string {
	return url.pathname.split("/").find(Boolean)?.toLowerCase() ?? "";
}

function normalizedPathname(url: URL): string {
	const normalized = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
	return normalized || "/";
}

function matchesSite(target: string | URL, site: StarlightShowcaseSite): boolean {
	const targetUrl = normalizedUrl(target);
	const siteUrl = normalizedUrl(site.url);
	if (!targetUrl || targetUrl.hostname !== siteUrl?.hostname) return false;
	if (targetUrl.hostname.endsWith(".github.io")) {
		return firstPathSegment(targetUrl) === firstPathSegment(siteUrl);
	}
	const targetPath = normalizedPathname(targetUrl);
	const sitePath = normalizedPathname(siteUrl);
	return sitePath === "/" || targetPath === sitePath || targetPath.startsWith(`${sitePath}/`);
}

export function parseStarlightShowcase(source: string): StarlightShowcaseSite[] {
	const sites: StarlightShowcaseSite[] = [];
	for (const match of source.matchAll(/<Card\b[\s\S]*?\/>/g)) {
		const tag = match[0];
		const title = /\btitle=(['"])(.*?)\1/s.exec(tag)?.[2];
		const url = /\bhref=(['"])(.*?)\1/s.exec(tag)?.[2];
		if (!title || !url || !normalizedUrl(url)) continue;
		sites.push({ title, url });
	}
	return sites;
}

async function fetchSites(fetchImplementation: typeof globalThis.fetch): Promise<StarlightShowcaseSite[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, FETCH_TIMEOUT_MS);
	try {
		const requestInit: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
			headers: { Accept: "text/plain" },
			signal: controller.signal,
			cf: { cacheEverything: true, cacheTtl: 86_400 },
		};
		const response = await fetchImplementation(STARLIGHT_SHOWCASE_SOURCE_URL, requestInit);
		if (!response.ok) throw new Error(`Starlight showcase returned ${String(response.status)}`);
		const source = await readResponseTextWithLimit(
			response,
			MAX_SOURCE_BYTES,
			"Starlight showcase source was too large",
		);
		const sites = parseStarlightShowcase(source);
		if (sites.length === 0) throw new Error("Starlight showcase source contained no sites");
		return sites;
	} finally {
		clearTimeout(timeout);
	}
}

async function getSites(fetchImplementation: typeof globalThis.fetch): Promise<StarlightShowcaseSite[]> {
	const now = Date.now();
	if (cache && cache.expiresAt > now) return cache.sites;
	if (inFlight) return inFlight;
	inFlight = fetchSites(fetchImplementation).then((sites) => {
		cache = { expiresAt: Date.now() + CACHE_TTL_MS, sites };
		return sites;
	});
	try {
		return await inFlight;
	} finally {
		inFlight = undefined;
	}
}

export function clearStarlightShowcaseCache(): void {
	cache = undefined;
	inFlight = undefined;
}

export async function getStarlightShowcaseStatus(
	targets: readonly (string | URL)[],
	fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<ShowcaseStatus> {
	const sites = await getSites(fetchImplementation);
	const match = sites.find((site) => targets.some((target) => matchesSite(target, site)));
	return match ? { listed: true, title: match.title, url: match.url } : { listed: false };
}
