export const prerender = false;
import type { APIRoute } from "astro";
import { isAstroWebsite, isValidUrl } from "@lib/modules/server";

export const GET: APIRoute = async ({ url }) => {
	const urlParam = url.searchParams.get("url");

	if (!urlParam) {
		return new Response(
			JSON.stringify({
				error: "Missing required query parameter: url",
			}),
			{
				status: 400,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	}

	const decodedUrl = decodeURIComponent(urlParam).trim();

	if (!isValidUrl(decodedUrl)) {
		return new Response(
			JSON.stringify({
				error: `URL: ${decodedUrl} is not a valid URL`,
			}),
			{
				status: 400,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	}

	try {
		const result = await isAstroWebsite(decodedUrl);
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
			},
		});
	} catch (_) {
		return new Response(
			JSON.stringify({
				error: `Unable to check ${decodedUrl}`,
			}),
			{
				status: 400,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	}
};
