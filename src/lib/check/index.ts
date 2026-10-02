import { findListing, getShowcaseSites, getStarlightShowcaseSites } from "@lib/showcase";
import { detect } from "./detect";
import { detectInfrastructure } from "./infrastructure";
import { cached, type TtlCache } from "./ttl-cache";
import type { Check } from "./types";
import { normalizeWebsiteInput } from "./url";

export type * from "./types";
export { PROVIDER_NAMES } from "./infrastructure";

export type CheckInputResult =
	| { ok: true; check: Check }
	| { ok: false; kind: "empty" | "invalid"; url: string; message: string };

const CHECK_TTL_MS = 5 * 60_000;
const checkCache: TtlCache<Check> = new Map();

/** Validates user input, then checks it. Only bad input fails; every fetch outcome is a Check. */
export async function checkWebsiteInput(
	input: string,
	fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CheckInputResult> {
	const normalized = normalizeWebsiteInput(input);
	if (!normalized.ok) return normalized;
	return { ok: true, check: await checkWebsite(normalized.url, fetch) };
}

/**
 * Cached per URL for five minutes. Transient failures (timeouts, network
 * errors) aren't cached so an immediate retry does real work.
 */
export function checkWebsite(
	url: string,
	fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Check> {
	return cached(checkCache, url, CHECK_TTL_MS, () => runCheck(url, fetch), isCacheable);
}

function isCacheable({ verdict }: Check): boolean {
	return (
		verdict.status !== "unreachable" ||
		(verdict.reason !== "timeout" && verdict.reason !== "network-error")
	);
}

async function runCheck(url: string, fetch: typeof globalThis.fetch): Promise<Check> {
	// Fetch the showcase lists alongside the page. They're cached for a day,
	// so a wasted prefetch costs one request per isolate per day.
	const astroSites = getShowcaseSites(fetch);
	const starlightSites = getStarlightShowcaseSites(fetch);
	for (const prefetch of [astroSites, starlightSites]) prefetch.catch(() => undefined);

	const { finalUrl, verdict, headers } = await detect(url, fetch);
	const [astroListing, starlightListing] = await Promise.all([
		verdict.status === "astro" ? settled(astroSites) : undefined,
		verdict.status === "astro" && verdict.starlight ? settled(starlightSites) : undefined,
	]);

	return {
		url,
		finalUrl,
		verdict,
		infrastructure: headers
			? detectInfrastructure(headers, finalUrl)
			: { providers: [], headers: [] },
		...(verdict.status === "astro" && {
			showcase: {
				...(astroListing && { astro: findListing(finalUrl, astroListing) }),
				...(starlightListing && { starlight: findListing(finalUrl, starlightListing) }),
			},
		}),
	};
}

/** Showcase lookups are best-effort: a failure omits them, never fails the check. */
async function settled<T>(promise: Promise<T>): Promise<T | undefined> {
	try {
		return await promise;
	} catch {
		return undefined;
	}
}
