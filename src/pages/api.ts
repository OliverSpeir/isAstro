export const prerender = false;
import type { APIRoute } from "astro";
import { checkWebsiteInput } from "@lib/check";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export const OPTIONS: APIRoute = () =>
	new Response(null, {
		status: 204,
		headers: {
			...CORS_HEADERS,
			"Access-Control-Max-Age": "86400",
			"Cache-Control": "public, max-age=86400",
		},
	});

/** 200 whenever the check ran, even if the site blocked us or was down. 400 only for bad input. */
export const GET: APIRoute = async ({ url }) => {
	const result = await checkWebsiteInput(url.searchParams.get("url") ?? "");
	if (!result.ok) {
		return Response.json(
			{ error: result.message, url: result.url },
			{ status: 400, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
		);
	}
	return Response.json(result.check, {
		headers: {
			...CORS_HEADERS,
			"Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
		},
	});
};
