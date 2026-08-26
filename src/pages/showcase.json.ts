export const prerender = false;
import type { APIRoute } from "astro";
import { getShowcaseSites } from "@lib/showcase";

type CloudflareCacheStorage = CacheStorage & { default?: Cache };
type RuntimeLocals = {
	runtime?: { ctx?: { waitUntil(promise: Promise<unknown>): void } };
};

export const GET: APIRoute = async ({ request, locals }) => {
	const edgeCache = (globalThis.caches as CloudflareCacheStorage | undefined)?.default;
	const cacheKey = new Request(new URL("/showcase.json", request.url), { method: "GET" });
	if (edgeCache) {
		try {
			const cached = await edgeCache.match(cacheKey);
			if (cached) return cached;
		} catch {
			// Cache availability must not determine whether fresh showcase data can be served.
		}
	}

	try {
		const response = Response.json(await getShowcaseSites(), {
			headers: {
				"Cache-Control": "public, max-age=86400",
				"Cache-Tag": "astro-showcase",
			},
		});
		if (edgeCache) {
			try {
				const cacheWrite = edgeCache.put(cacheKey, response.clone()).catch(() => undefined);
				const runtime = (locals as RuntimeLocals).runtime;
				if (runtime?.ctx) runtime.ctx.waitUntil(cacheWrite);
				else void cacheWrite;
			} catch {
				// A cache write is an optimization; the successfully fetched response remains valid.
			}
		}
		return response;
	} catch {
		return Response.json(
			{ error: "Unable to load the Astro showcase." },
			{ status: 502, headers: { "Cache-Control": "no-store" } },
		);
	}
};
