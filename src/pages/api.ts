export const prerender = false;
import type { APIRoute } from "astro";
import {
	isAstroWebsite,
	isValidUrl,
	addProtocolToUrlAndTrim,
	CustomError,
} from "@lib/modules/server";

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

	const decodedUrl = decodeURIComponent(addProtocolToUrlAndTrim(urlParam));

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
	} catch (error) {
		if (error instanceof CustomError) {
			return new Response(
				JSON.stringify({
					isAstro: false,
					mechanism: error.message,
					url: error.originalUrl,
					lastFetchedUrl: error.lastFetchedUrl,
				}),
				{
					status: 500,
					headers: {
						"Content-Type": "application/json",
					},
				},
			);
		}

		return new Response(
			JSON.stringify({
				isAstro: false,
				mechanism: "Unknown error",
				url: decodedUrl,
			}),
			{
				status: 500,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	}
};
