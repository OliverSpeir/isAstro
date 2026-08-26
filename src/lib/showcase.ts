import { readResponseTextWithLimit } from "@modules/server/response";

export const ASTRO_SHOWCASE_API_URL = "https://astro.build/api/showcase.json";

export type ShowcaseSite = {
	title: string;
	url: string;
	slug: string;
};

export type ShowcaseStatus = { listed: false } | { listed: true; title: string; url: string };

const SHOWCASE_CACHE_TTL_MS = 24 * 60 * 60_000;
const SHOWCASE_FETCH_TIMEOUT_MS = 3_000;
const MAX_SHOWCASE_BYTES = 2_000_000;

let cache: { expiresAt: number; sites: ShowcaseSite[] } | undefined;
let inFlight: Promise<ShowcaseSite[]> | undefined;

function hostnameForComparison(value: string | URL): string | undefined {
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
			return undefined;
		}
		return url.hostname
			.toLowerCase()
			.replace(/^www\./, "")
			.replace(/\.$/, "");
	} catch {
		return undefined;
	}
}

function normalizedPathname(value: string | URL): string | undefined {
	try {
		const url = new URL(value);
		if (!hostnameForComparison(url)) return undefined;
		const normalized = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
		return normalized || "/";
	} catch {
		return undefined;
	}
}

function matchesShowcasePath(target: string | URL, site: string | URL): boolean {
	const targetPath = normalizedPathname(target);
	const sitePath = normalizedPathname(site);
	if (!targetPath || !sitePath) return false;
	if (sitePath === "/") return true;
	return targetPath === sitePath || targetPath.startsWith(`${sitePath}/`);
}

function githubPagesProject(value: string | URL): string | undefined {
	try {
		const url = new URL(value);
		const hostname = hostnameForComparison(url);
		if (!hostname?.endsWith(".github.io")) return undefined;
		return url.pathname.split("/").find(Boolean)?.toLowerCase() ?? "";
	} catch {
		return undefined;
	}
}

function isShowcaseSite(value: unknown): value is ShowcaseSite {
	if (!value || typeof value !== "object") return false;
	const site = value as Record<string, unknown>;
	return (
		typeof site.title === "string" &&
		typeof site.url === "string" &&
		typeof site.slug === "string" &&
		hostnameForComparison(site.url) !== undefined
	);
}

async function fetchShowcaseSites(
	fetchImplementation: typeof globalThis.fetch,
): Promise<ShowcaseSite[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, SHOWCASE_FETCH_TIMEOUT_MS);
	try {
		const requestInit: RequestInit & {
			cf?: { cacheEverything: boolean; cacheTtl: number };
		} = {
			headers: { Accept: "application/json" },
			signal: controller.signal,
			cf: { cacheEverything: true, cacheTtl: 86_400 },
		};
		const response = await fetchImplementation(ASTRO_SHOWCASE_API_URL, requestInit);
		if (!response.ok) throw new Error(`Astro showcase returned ${String(response.status)}`);

		const body = await readResponseTextWithLimit(
			response,
			MAX_SHOWCASE_BYTES,
			"Astro showcase response was too large",
		);
		const value: unknown = JSON.parse(body);
		if (!Array.isArray(value)) throw new Error("Astro showcase response was invalid");

		const sites = value.filter(isShowcaseSite);
		if (sites.length === 0) throw new Error("Astro showcase response contained no sites");
		return sites;
	} finally {
		clearTimeout(timeout);
	}
}

export function findShowcaseSite(
	targets: readonly (string | URL)[],
	sites: readonly ShowcaseSite[],
): ShowcaseSite | undefined {
	const targetHostnames = new Set(
		targets.map(hostnameForComparison).filter((hostname): hostname is string => Boolean(hostname)),
	);
	if (targetHostnames.size === 0) return undefined;
	return sites.find((site) => {
		const hostname = hostnameForComparison(site.url);
		if (hostname === undefined || !targetHostnames.has(hostname)) return false;

		// A hostname can contain multiple unrelated projects. Match non-root
		// listing paths, with first-segment identity for GitHub Pages projects.
		return targets.some((target) => {
			if (hostnameForComparison(target) !== hostname) return false;
			if (hostname.endsWith(".github.io")) {
				return githubPagesProject(target) === githubPagesProject(site.url);
			}
			return matchesShowcasePath(target, site.url);
		});
	});
}

export async function getShowcaseSites(
	fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<ShowcaseSite[]> {
	const now = Date.now();
	if (cache && cache.expiresAt > now) return cache.sites;
	if (inFlight) return inFlight;

	inFlight = fetchShowcaseSites(fetchImplementation).then((sites) => {
		cache = { expiresAt: Date.now() + SHOWCASE_CACHE_TTL_MS, sites };
		return sites;
	});
	try {
		return await inFlight;
	} finally {
		inFlight = undefined;
	}
}

export function clearShowcaseCache(): void {
	cache = undefined;
	inFlight = undefined;
}

export async function getShowcaseStatus(
	targets: readonly (string | URL)[],
	fetchImplementation?: typeof globalThis.fetch,
): Promise<ShowcaseStatus> {
	const match = findShowcaseSite(targets, await getShowcaseSites(fetchImplementation));
	return match ? { listed: true, title: match.title, url: match.url } : { listed: false };
}
