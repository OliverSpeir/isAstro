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
	const ipv4 = parseIpv4(hostname);
	if (ipv4) return !isPrivateIpv4(ipv4);
	if (hostname.includes(":")) return !isPrivateIpv6(hostname);
	return hostname.includes(".");
}

function parseIpv4(hostname: string): number[] | undefined {
	const parts = hostname.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map(Number);
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
		return undefined;
	return octets;
}

function isPrivateIpv4([first = 0, second = 0, third = 0]: number[]): boolean {
	return (
		first === 0 ||
		first === 10 ||
		(first === 100 && second >= 64 && second <= 127) ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 0 && (third === 0 || third === 2)) ||
		(first === 192 && second === 88 && third === 99) ||
		(first === 192 && second === 168) ||
		(first === 198 && (second === 18 || second === 19)) ||
		(first === 198 && second === 51 && third === 100) ||
		(first === 203 && second === 0 && third === 113) ||
		first >= 224
	);
}

function parseIpv6(hostname: string): bigint | undefined {
	let host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host.includes("%")) return undefined;
	if (host.includes(".")) {
		const lastColon = host.lastIndexOf(":");
		const ipv4 = parseIpv4(host.slice(lastColon + 1));
		if (!ipv4) return undefined;
		const [a = 0, b = 0, c = 0, d = 0] = ipv4;
		host = `${host.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}

	const halves = host.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
	const groups = [...left, ...Array<string>(Math.max(zeroCount, 0)).fill("0"), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
		return undefined;
	}
	return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

const PRIVATE_IPV6_RANGES = (
	[
		["::", 128],
		["::1", 128],
		["::ffff:0:0", 96],
		["64:ff9b::", 96],
		["100::", 64],
		["2001::", 23],
		["2001:db8::", 32],
		["2002::", 16],
		["fc00::", 7],
		["fe80::", 10],
		["ff00::", 8],
	] as const
).map(([base, prefixLength]) => ({
	base: parseIpv6(base) ?? 0n,
	shift: BigInt(128 - prefixLength),
}));

function isPrivateIpv6(hostname: string): boolean {
	const value = parseIpv6(hostname);
	if (value === undefined) return true;
	return PRIVATE_IPV6_RANGES.some(({ base, shift }) => value >> shift === base >> shift);
}
