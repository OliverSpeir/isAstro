import {
	CustomError,
	getCachedAstroDetection,
	type CachedDetectionOptions,
	type DetectionResult,
} from "./index";
import { addProtocolToUrlAndTrim, isValidUrl } from "./utils";

export type WebsiteCheckFailureKind = "empty" | "invalid" | "request";

export type WebsiteCheckResult =
	| {
			ok: true;
			normalizedUrl: string;
			result: DetectionResult;
	  }
	| {
			ok: false;
			kind: WebsiteCheckFailureKind;
			normalizedUrl: string;
			message: string;
			lastFetchedUrl?: string;
	  };

export function normalizeWebsiteUrl(
	input: string,
):
	| { ok: true; url: string }
	| { ok: false; kind: "empty" | "invalid"; url: string; message: string } {
	const trimmedInput = input.trim();
	if (!trimmedInput) {
		return { ok: false, kind: "empty", url: "", message: "Enter a website URL." };
	}

	const candidate = addProtocolToUrlAndTrim(trimmedInput);
	if (!isValidUrl(candidate)) {
		return {
			ok: false,
			kind: "invalid",
			url: candidate,
			message: "Enter a valid public website URL, such as https://example.com.",
		};
	}

	return { ok: true, url: new URL(candidate).toString() };
}

export async function checkWebsiteInput(
	input: string,
	options: CachedDetectionOptions = {},
): Promise<WebsiteCheckResult> {
	const normalized = normalizeWebsiteUrl(input);
	if (!normalized.ok) {
		return {
			ok: false,
			kind: normalized.kind,
			normalizedUrl: normalized.url,
			message: normalized.message,
		};
	}

	try {
		return {
			ok: true,
			normalizedUrl: normalized.url,
			result: await getCachedAstroDetection(normalized.url, options),
		};
	} catch (error) {
		if (error instanceof CustomError) {
			return {
				ok: false,
				kind: "request",
				normalizedUrl: error.originalUrl,
				message: error.message,
				...(error.lastFetchedUrl && { lastFetchedUrl: error.lastFetchedUrl }),
			};
		}

		return {
			ok: false,
			kind: "request",
			normalizedUrl: normalized.url,
			message: "Unable to check this website.",
		};
	}
}
