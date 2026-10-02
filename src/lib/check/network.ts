import { resolveAddresses } from "./dns";
import { isCloudflareAddress, isPrivateAddress } from "./ip";
import { socketHead, type Connect } from "./socket-head";

/** How checks reach the internet. Without `connect` (e.g. local dev), fetch() headers are used as-is. */
export type Network = { fetch: typeof globalThis.fetch; connect?: Connect | undefined };

export type PageFetch = (
	url: string,
	init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

/** How long to wait for a socket's headers once the check is otherwise done. */
const SOCKET_GRACE_MS = 1_000;
/** The error Workers raise for sockets to Cloudflare's own network. */
const SOCKET_REFUSED = /cannot connect to the specified address/i;
/** Headers fetch() inside Cloudflare can add to (or overwrite on) responses. */
const CLOUDFLARE_INJECTED_HEADERS = ["server", "cf-ray", "cf-cache-status"];

type SocketResult = { status: number; headers: Headers } | "refused" | undefined;
type Hop = { onCloudflare: boolean; socket: Promise<SocketResult>; status?: number };

/**
 * Pages always come through fetch(), which sites accept most reliably. But
 * fetch() inside Cloudflare can rewrite `server` and add `cf-ray`, so a raw
 * socket reads each URL's response head in parallel, purely to report the
 * headers the server really sent. Sockets can't reach Cloudflare's network;
 * for those sites Cloudflare really is in front, so fetch()'s headers stand.
 */
export function createPageFetch({ fetch, connect }: Network) {
	const hops = new Map<string, Hop>();

	const fetchPage: PageFetch = async (url, init) => {
		const addresses = await resolveAddresses(new URL(url).hostname, fetch);
		if (addresses.length === 0) throw new Error("No DNS records");
		if (addresses.some(isPrivateAddress)) throw new Error("Resolves to a private address");

		const onCloudflare = addresses.some(isCloudflareAddress);
		const hop: Hop = {
			onCloudflare,
			socket:
				connect && !onCloudflare
					? socketHead(connect, url, init).catch((error: unknown) =>
							error instanceof Error && SOCKET_REFUSED.test(error.message) ? "refused" : undefined,
						)
					: Promise.resolve(undefined),
		};
		hops.set(url, hop);
		const response = await fetch(url, { ...init, redirect: "manual" });
		hop.status = response.status;
		return response;
	};

	/** The headers to report for `url`: the socket's when it saw the same response, else fetch()'s. */
	async function originHeaders(url: string, fetched: Headers): Promise<Headers> {
		const hop = hops.get(url);
		if (!connect || !hop || hop.onCloudflare) return fetched;
		const grace = new Promise<undefined>((resolve) => setTimeout(resolve, SOCKET_GRACE_MS));
		const socket = await Promise.race([hop.socket, grace]);
		if (socket === "refused") return fetched;
		if (socket && socket.status === hop.status) return socket.headers;
		return withoutHeaders(fetched, CLOUDFLARE_INJECTED_HEADERS);
	}

	return { fetchPage, originHeaders };
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
