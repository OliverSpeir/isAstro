import { createPageScanner } from "./html-scanner";
import type { PageFetch } from "./network";
import type { Verdict } from "./types";
import { isPublicHttpUrl } from "./url";

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const BOT_WALL_SCAN_BYTES = 65_536;
const REQUEST_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml",
	"Accept-Language": "en-US,en;q=0.5",
};

export type Detection = { finalUrl: string; verdict: Verdict; headers?: Headers };

type Step =
	| { state: "fetch"; url: string; redirects: number }
	| { state: "classify"; url: string; redirects: number; response: Response }
	| { state: "scan"; url: string; redirects: number; response: Response }
	| { state: "done"; detection: Detection };

/**
 * fetch → classify → scan → done, where redirects and meta refreshes loop back
 * to fetch. Every exit is a Verdict, so callers never see thrown errors.
 */
export async function detect(url: string, fetchPage: PageFetch): Promise<Detection> {
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	let step: Step = { state: "fetch", url, redirects: 0 };
	try {
		while (step.state !== "done") {
			if (step.state === "fetch") {
				const response = await fetchPage(step.url, { signal, headers: REQUEST_HEADERS });
				step = { ...step, state: "classify", response };
			} else if (step.state === "classify") {
				step = await classify(step);
			} else {
				step = await scan(step);
			}
		}
		return step.detection;
	} catch {
		const reason = signal.aborted ? "timeout" : "network-error";
		return {
			finalUrl: step.state === "done" ? step.detection.finalUrl : step.url,
			verdict: { status: "unreachable", reason },
		};
	}
}

async function classify({
	url,
	redirects,
	response,
}: Extract<Step, { state: "classify" }>): Promise<Step> {
	const { status, headers } = response;
	const done = (verdict: Verdict): Step => {
		void response.body?.cancel().catch(() => undefined);
		return { state: "done", detection: { finalUrl: url, verdict, headers } };
	};

	if (status >= 300 && status < 400) {
		const location = headers.get("location");
		if (!location) return done({ status: "unreachable", reason: "http-error", httpStatus: status });
		void response.body?.cancel().catch(() => undefined);
		return follow(location, url, redirects, headers);
	}
	const blockedBy = botWallFromHeaders(headers);
	if (blockedBy) return done({ status: "blocked", by: blockedBy });
	if (!response.ok) {
		const prefix = await readPrefix(response, BOT_WALL_SCAN_BYTES);
		const bodyWall = botWallFromBody(prefix);
		const cloudflareError =
			headers.get("server")?.toLowerCase() === "cloudflare"
				? cloudflareErrorCode(prefix)
				: undefined;
		return done(
			bodyWall
				? { status: "blocked", by: bodyWall }
				: {
						status: "unreachable",
						reason: "http-error",
						httpStatus: status,
						...(cloudflareError && { cloudflareError }),
					},
		);
	}
	const mimeType = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (mimeType && mimeType !== "text/html" && mimeType !== "application/xhtml+xml") {
		return done({ status: "unreachable", reason: "not-html" });
	}
	if (Number(headers.get("content-length")) > MAX_BYTES)
		return done({ status: "unreachable", reason: "too-large" });
	return { state: "scan", url, redirects, response };
}

async function scan({ url, redirects, response }: Extract<Step, { state: "scan" }>): Promise<Step> {
	const { headers } = response;
	const done = (verdict: Verdict): Step => ({
		state: "done",
		detection: { finalUrl: url, verdict, headers },
	});
	if (!response.body) return done({ status: "unreachable", reason: "empty-body" });

	const scanner = createPageScanner(url);
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let bytes = 0;
	let prefix = "";
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			bytes += chunk.value.byteLength;
			if (bytes > MAX_BYTES) return done({ status: "unreachable", reason: "too-large" });
			const text = decoder.decode(chunk.value, { stream: true });
			if (prefix.length < BOT_WALL_SCAN_BYTES) prefix += text;

			const result = scanner.write(text);
			if (result?.status === "meta-refresh") {
				const wall = botWallFromBody(result.location);
				return wall
					? done({ status: "blocked", by: wall })
					: follow(result.location, url, redirects, headers);
			}
			if (result?.status === "astro") return done(result);
		}
	} finally {
		reader.releaseLock();
		void response.body.cancel().catch(() => undefined);
	}
	if (bytes === 0) return done({ status: "unreachable", reason: "empty-body" });

	const result = scanner.end();
	if (result.status === "astro") return done(result);
	// Only checked for pages that look non-Astro: real pages can embed Cloudflare's challenge script.
	const wall = botWallFromBody(prefix);
	return done(wall ? { status: "blocked", by: wall } : { status: "not-astro" });
}

function follow(location: string, from: string, redirects: number, headers: Headers): Step {
	const done = (verdict: Verdict): Step => ({
		state: "done",
		detection: { finalUrl: from, verdict, headers },
	});
	if (redirects >= MAX_REDIRECTS)
		return done({ status: "unreachable", reason: "too-many-redirects" });
	const next = URL.canParse(location, from) ? new URL(location, from) : undefined;
	if (!next || !isPublicHttpUrl(next.toString())) {
		return done({ status: "unreachable", reason: "disallowed-redirect" });
	}
	next.hash = "";
	return { state: "fetch", url: next.toString(), redirects: redirects + 1 };
}

type BotWall = Extract<Verdict, { status: "blocked" }>["by"];

function botWallFromHeaders(headers: Headers): BotWall | undefined {
	if (headers.get("cf-mitigated") === "challenge") return "cloudflare";
	if (headers.get("x-vercel-mitigated") === "challenge") return "vercel";
	return undefined;
}

function botWallFromBody(text: string): BotWall | undefined {
	if (text.includes("_cf_chl_opt")) return "cloudflare";
	if (/Vercel Security Checkpoint/i.test(text)) return "vercel";
	if (/\.well-known\/sgcaptcha/i.test(text)) return "sgcaptcha";
	// Lookalike interstitials (e.g. WordPress plugins) copy Cloudflare's wording.
	if (/<title>(Just a moment|Checking your browser)/i.test(text)) return "unknown";
	return undefined;
}

/** The 1xxx code on a Cloudflare error page ("error code: 1016", or the HTML page's code span). */
function cloudflareErrorCode(text: string): number | undefined {
	const match = /error code:?\s*(1\d{3})\b|cf-error-code">\s*(1\d{3})/i.exec(text);
	return match ? Number(match[1] ?? match[2]) : undefined;
}

async function readPrefix(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (
			let chunk = await reader.read();
			!chunk.done && text.length < maxBytes;
			chunk = await reader.read()
		) {
			text += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		reader.releaseLock();
		void response.body.cancel().catch(() => undefined);
	}
	return text;
}
