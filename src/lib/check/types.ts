import type { ShowcaseStatus } from "@lib/showcase";

/** What the page tells us about Astro, or why it couldn't tell us anything. */
export type Verdict =
	| {
			status: "astro";
			starlight: boolean;
			astroVersion?: string;
			starlightVersion?: string;
			evidence: string[];
	  }
	| { status: "not-astro" }
	| { status: "blocked"; by: "cloudflare" | "vercel" | "sgcaptcha" | "unknown" }
	| { status: "unreachable"; reason: UnreachableReason; httpStatus?: number };

export type UnreachableReason =
	| "timeout"
	| "network-error"
	| "http-error"
	| "not-html"
	| "empty-body"
	| "too-large"
	| "too-many-redirects"
	| "disallowed-redirect";

export type Provider = {
	name: string;
	/** Hostnames and response headers are "confirmed"; DNS or conflicting headers are "likely". */
	confidence: "confirmed" | "likely";
	evidence: string[];
};

/**
 * One infrastructure layer. "hidden" means a CDN answered, so the origin behind
 * it is deliberately not observable, which is expected rather than a failure.
 */
export type Layer =
	{ status: "identified"; providers: Provider[] } | { status: "hidden" } | { status: "unknown" };

export type Infrastructure = { edge: Layer; host: Layer };

export type Check = {
	url: string;
	finalUrl: string;
	verdict: Verdict;
	infrastructure: Infrastructure;
	showcase?: { astro?: ShowcaseStatus; starlight?: ShowcaseStatus };
};

/** Test/runtime seams. Every field defaults to the real implementation. */
export type CheckOptions = {
	fetch?: typeof globalThis.fetch;
	dnsFetch?: typeof globalThis.fetch;
	showcaseFetch?: typeof globalThis.fetch;
	starlightShowcaseFetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
};
