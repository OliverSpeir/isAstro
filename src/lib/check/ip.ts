type Address = { bits: 32 | 128; value: bigint };

/** Parses an IPv4 or IPv6 literal (brackets allowed). */
export function parseAddress(text: string): Address | undefined {
	const ipv4 = parseIpv4(text);
	if (ipv4 !== undefined) return { bits: 32, value: ipv4 };
	const ipv6 = parseIpv6(text);
	return ipv6 === undefined ? undefined : { bits: 128, value: ipv6 };
}

function parseIpv4(text: string): bigint | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
	if (octets.some((octet) => !(octet >= 0 && octet <= 255))) return undefined;
	return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function parseIpv6(text: string): bigint | undefined {
	let host = text.replace(/^\[|\]$/g, "").toLowerCase();
	if (!host.includes(":") || host.includes("%")) return undefined;
	if (host.includes(".")) {
		const lastColon = host.lastIndexOf(":");
		const ipv4 = parseIpv4(host.slice(lastColon + 1));
		if (ipv4 === undefined) return undefined;
		host = `${host.slice(0, lastColon)}:${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
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

function ranges(cidrs: string[]) {
	return cidrs.map((cidr) => {
		const [base = "", prefixLength = ""] = cidr.split("/");
		const address = parseAddress(base) ?? { bits: 32, value: 0n };
		const shift = BigInt(address.bits - Number(prefixLength));
		return { bits: address.bits, prefix: address.value >> shift, shift };
	});
}

function inRanges(text: string, list: ReturnType<typeof ranges>): boolean {
	const address = parseAddress(text);
	return list.some(
		({ bits, prefix, shift }) => address?.bits === bits && address.value >> shift === prefix,
	);
}

// Loopback, private, link-local, documentation, benchmarking, multicast and other reserved space.
const PRIVATE_RANGES = ranges([
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/3",
	"::/128",
	"::1/128",
	"::ffff:0:0/96",
	"64:ff9b::/96",
	"100::/64",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
	"fc00::/7",
	"fe80::/10",
	"ff00::/8",
]);

// https://www.cloudflare.com/ips/
const CLOUDFLARE_RANGES = ranges([
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
]);

/** True for reserved addresses, and for anything that isn't a valid address. */
export function isPrivateAddress(text: string): boolean {
	return !parseAddress(text) || inRanges(text, PRIVATE_RANGES);
}

export function isCloudflareAddress(text: string): boolean {
	return inRanges(text, CLOUDFLARE_RANGES);
}
