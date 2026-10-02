import { resolveAddresses } from "./dns";
import { isCloudflareAddress, isPrivateAddress } from "./ip";
import { socketFetch, type Connect } from "./socket-fetch";

/** How checks reach the internet. Without `connect` (e.g. local dev), pages go through fetch(). */
export type Network = { fetch: typeof globalThis.fetch; connect?: Connect | undefined };

export type PageFetch = (
	url: string,
	init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

/**
 * Fetches a page with the headers its server actually sent. Inside Cloudflare,
 * fetch() rewrites `server` and adds `cf-ray` to every response, so sites are
 * fetched over a raw socket. Sockets can't reach Cloudflare's own addresses;
 * those sites really are behind Cloudflare, so fetch() reports them truthfully.
 */
export function createPageFetch({ fetch, connect }: Network): PageFetch {
	return async (url, init) => {
		const addresses = await resolveAddresses(new URL(url).hostname, fetch);
		if (addresses.length === 0) throw new Error("No DNS records");
		if (addresses.some(isPrivateAddress)) throw new Error("Resolves to a private address");
		if (!connect || addresses.some(isCloudflareAddress)) {
			return fetch(url, { ...init, redirect: "manual" });
		}
		return socketFetch(connect, url, init);
	};
}

/** The Workers socket API, when running on Cloudflare. */
export async function loadConnect(): Promise<Connect | undefined> {
	try {
		return (await import("cloudflare:sockets")).connect;
	} catch {
		return undefined;
	}
}
