import { resolveAddresses } from "./dns";
import { isCloudflareAddress, isPrivateAddress } from "./ip";
import { socketHead, type Connect } from "./socket-head";

/** How checks reach the internet. Without `connect` (e.g. local dev), fetch() headers are used as-is. */
export type Network = { fetch: typeof globalThis.fetch; connect?: Connect | undefined };

export type PageFetch = (
	url: string,
	init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

/** How long to wait for the socket's headers once fetch() has its response. */
const SOCKET_GRACE_MS = 1_000;
/** The error Workers raise for sockets to Cloudflare's own network. */
const SOCKET_REFUSED = /cannot connect to the specified address/i;
/** Headers fetch() inside Cloudflare adds to (or overwrites on) every response. */
const CLOUDFLARE_INJECTED_HEADERS = ["server", "cf-ray", "cf-cache-status"];

type SocketResult = { status: number; headers: Headers } | "refused" | undefined;

/**
 * Pages always come through fetch(), which sites accept most reliably. But
 * inside Cloudflare, fetch() rewrites `server` and adds `cf-ray` to every
 * response, so a raw socket fetches the same URL's head in parallel, and its
 * headers replace fetch()'s when both got the same status. Sockets can't reach
 * Cloudflare's network; for those sites Cloudflare really is in front, so
 * fetch()'s headers are already truthful.
 */
export function createPageFetch({ fetch, connect }: Network): PageFetch {
	return async (url, init) => {
		const addresses = await resolveAddresses(new URL(url).hostname, fetch);
		if (addresses.length === 0) throw new Error("No DNS records");
		if (addresses.some(isPrivateAddress)) throw new Error("Resolves to a private address");

		const onCloudflare = addresses.some(isCloudflareAddress);
		const socket: Promise<SocketResult> =
			connect && !onCloudflare
				? socketHead(connect, url, init).catch((error: unknown) =>
						error instanceof Error && SOCKET_REFUSED.test(error.message) ? "refused" : undefined,
					)
				: Promise.resolve(undefined);
		const response = await fetch(url, { ...init, redirect: "manual" });
		if (!connect || onCloudflare) return response;

		const grace = new Promise<undefined>((resolve) => setTimeout(resolve, SOCKET_GRACE_MS));
		const origin = await Promise.race([socket, grace]);
		if (origin === "refused") return response;
		const headers =
			origin?.status === response.status
				? origin.headers
				: withoutHeaders(response.headers, CLOUDFLARE_INJECTED_HEADERS);
		return new Response(response.body, { status: response.status, headers });
	};
}

function withoutHeaders(source: Headers, names: string[]): Headers {
	const headers = new Headers(source);
	for (const name of names) headers.delete(name);
	return headers;
}

/** The Workers socket API, when running on Cloudflare. */
export async function loadConnect(): Promise<Connect | undefined> {
	try {
		return (await import("cloudflare:sockets")).connect;
	} catch {
		return undefined;
	}
}
