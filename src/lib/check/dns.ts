import { parseAddress } from "./ip";
import { cached, type TtlCache } from "./ttl-cache";

const DNS_TTL_MS = 5 * 60_000;
const DNS_RECORD_TYPES = { A: 1, AAAA: 28 };
const addressCache: TtlCache<string[]> = new Map();

/** A and AAAA addresses for a hostname via DNS-over-HTTPS (CNAMEs are followed by the resolver). */
export function resolveAddresses(
	hostname: string,
	fetch: typeof globalThis.fetch,
): Promise<string[]> {
	if (parseAddress(hostname)) return Promise.resolve([hostname.replace(/^\[|\]$/g, "")]);
	return cached(addressCache, hostname, DNS_TTL_MS, async () => {
		const answers = await Promise.all(
			Object.entries(DNS_RECORD_TYPES).map(async ([name, type]) => {
				const response = await fetch(
					`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${name}`,
					{ headers: { accept: "application/dns-json" } },
				);
				if (!response.ok) throw new Error(`DNS lookup failed with ${String(response.status)}`);
				return addressesOfType(await response.json(), type);
			}),
		);
		return answers.flat();
	});
}

function addressesOfType(json: unknown, type: number): string[] {
	if (typeof json !== "object" || json === null || !("Answer" in json)) return [];
	if (!Array.isArray(json.Answer)) return [];
	return json.Answer.flatMap((record: unknown) =>
		typeof record === "object" &&
		record !== null &&
		"type" in record &&
		"data" in record &&
		record.type === type &&
		typeof record.data === "string"
			? [record.data]
			: [],
	);
}
