export const prerender = false;
import type { APIRoute } from "astro";
import { checkWebsiteInput } from "@lib/modules/server/request";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
} as const;

const JSON_HEADERS = {
	...CORS_HEADERS,
	"Content-Type": "application/json; charset=utf-8",
} as const;

function json(body: unknown, status: number, cacheControl = "no-store"): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS, "Cache-Control": cacheControl },
	});
}

export const OPTIONS: APIRoute = () =>
	new Response(null, {
		status: 204,
		headers: {
			...CORS_HEADERS,
			"Access-Control-Max-Age": "86400",
			Allow: "GET, OPTIONS",
			"Cache-Control": "public, max-age=86400",
		},
	});

export const GET: APIRoute = async ({ url }) => {
	const urlParam = url.searchParams.get("url");
	if (urlParam === null) {
		return json({ error: "Missing required query parameter: url" }, 400);
	}

	const check = await checkWebsiteInput(urlParam);
	if (check.ok) {
		return json(check.result, 200, "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
	}

	if (check.kind !== "request") {
		return json({ error: check.message, url: check.normalizedUrl }, 400);
	}

	const status = check.message === "Request timed out" ? 504 : 502;
	return json(
		{
			isAstro: false,
			isStarlight: false,
			mechanism: check.message,
			url: check.normalizedUrl,
			...(check.lastFetchedUrl && { lastFetchedUrl: check.lastFetchedUrl }),
		},
		status,
	);
};
