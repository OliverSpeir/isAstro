import {
	CustomError,
	getCachedAstroDetection,
	type CachedDetectionOptions,
	type DetectionResult,
} from "./index";
import { addProtocolToUrlAndTrim, isValidUrl } from "./utils";
import { getShowcaseStatus } from "@lib/showcase";
import { getStarlightShowcaseStatus } from "@lib/starlight-showcase";
import {
	detectDnsInfrastructure,
	sortInfrastructureProviders,
	type InfrastructureProvider,
} from "./hosting";

export type WebsiteCheckFailureKind = "empty" | "invalid" | "request";

export type WebsiteCheckOptions = CachedDetectionOptions & {
	includeShowcase?: boolean;
	showcaseFetch?: typeof globalThis.fetch;
	starlightShowcaseFetch?: typeof globalThis.fetch;
	includeDnsInfrastructure?: boolean;
	dnsFetch?: typeof globalThis.fetch;
};

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

	const url = new URL(candidate);
	url.hash = "";
	return { ok: true, url: url.toString() };
}

export async function checkWebsiteInput(
	input: string,
	options: WebsiteCheckOptions = {},
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
		const {
			includeShowcase = true,
			showcaseFetch,
			starlightShowcaseFetch,
			includeDnsInfrastructure = true,
			dnsFetch,
			...detectionOptions
		} = options;
		const result = await getCachedAstroDetection(normalized.url, detectionOptions);
		if (result.isAstro) {
			const targets = [result.lastFetchedUrl];
			const knownInfrastructureLayers = new Set(
				result.infrastructure?.map((provider) => provider.layer) ?? [],
			);
			const hasCompleteInfrastructure =
				knownInfrastructureLayers.has("edge") && knownInfrastructureLayers.has("hosting");
			const [astroShowcase, starlightShowcase, dnsInfrastructure] = await Promise.allSettled([
				includeShowcase
					? getShowcaseStatus(targets, showcaseFetch)
					: Promise.resolve(undefined),
				includeShowcase && result.isStarlight
					? getStarlightShowcaseStatus(targets, starlightShowcaseFetch)
					: Promise.resolve(undefined),
				includeDnsInfrastructure && !hasCompleteInfrastructure
					? detectDnsInfrastructure(result.lastFetchedUrl, dnsFetch)
					: Promise.resolve([] as InfrastructureProvider[]),
			]);

			const dnsProviders =
				dnsInfrastructure.status === "fulfilled"
					? dnsInfrastructure.value.filter(
							(provider) => !knownInfrastructureLayers.has(provider.layer),
						)
					: [];
			const infrastructure = sortInfrastructureProviders([
				...(result.infrastructure ?? []),
				...dnsProviders,
			]);
			return {
				ok: true,
				normalizedUrl: normalized.url,
				result: {
					...result,
					...(infrastructure.length > 0 && { infrastructure }),
					...(astroShowcase.status === "fulfilled" &&
						astroShowcase.value && { showcase: astroShowcase.value }),
					...(starlightShowcase.status === "fulfilled" &&
						starlightShowcase.value && { starlightShowcase: starlightShowcase.value }),
				},
			};
		}
		return {
			ok: true,
			normalizedUrl: normalized.url,
			result,
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
