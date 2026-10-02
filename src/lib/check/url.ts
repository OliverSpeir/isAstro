import { isPrivateAddress, parseAddress } from "./ip";

export type NormalizedInput =
	| { ok: true; url: string }
	| { ok: false; kind: "empty" | "invalid"; url: string; message: string };

/** Turns user input ("astro.build", " https://x.dev/#a ") into a validated public URL. */
export function normalizeWebsiteInput(input: string): NormalizedInput {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, kind: "empty", url: "", message: "Enter a website URL." };

	const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	if (!isPublicHttpUrl(candidate)) {
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

/** Blocks non-HTTP schemes, credentials, and private/reserved hosts (SSRF guard, run on every hop). */
export function isPublicHttpUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (!url.hostname || url.username || url.password) return false;

	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		return false;
	}
	if (parseAddress(hostname)) return !isPrivateAddress(hostname);
	return !hostname.includes(":") && hostname.includes(".");
}
