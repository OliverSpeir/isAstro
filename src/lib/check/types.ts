import type { ShowcaseStatus } from "@lib/showcase";

/** What the page tells us about Astro, or why it couldn't tell us anything. */
export type Verdict =
	| {
			status: "astro";
			starlight: boolean;
			astroVersion?: string;
			starlightVersion?: string;
			/** Strongest first, e.g. the generator tag, then the markers seen before deciding. */
			evidence: string[];
			/** The Starlight generator tag, when present. */
			starlightEvidence?: string[];
	  }
	| { status: "not-astro" }
	| { status: "blocked"; by: "cloudflare" | "vercel" | "sgcaptcha" | "unknown" }
	| {
			status: "unreachable";
			reason: UnreachableReason;
			httpStatus?: number;
			/** Cloudflare's 1xxx code from its error page, e.g. 1016 (origin DNS error). */
			cloudflareError?: number;
	  };

export type UnreachableReason =
	| "timeout"
	| "network-error"
	| "http-error"
	| "not-html"
	| "empty-body"
	| "too-large"
	| "too-many-redirects"
	| "disallowed-redirect";

/** A provider named by a signal only it emits; evidence quotes each signal seen. */
export type Provider = { name: string; role: "cdn" | "hosting"; evidence: string[] };

/**
 * What the final response says about how it was served. A CDN usually hides
 * the origin, so `providers` may name only the CDN; `headers` are the raw facts.
 */
export type Infrastructure = {
	providers: Provider[];
	headers: { name: string; value: string }[];
};

export type Check = {
	url: string;
	finalUrl: string;
	verdict: Verdict;
	infrastructure: Infrastructure;
	showcase?: { astro?: ShowcaseStatus; starlight?: ShowcaseStatus };
};
