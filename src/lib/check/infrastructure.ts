import { readTextWithLimit } from "./read-text";
import { cached } from "./ttl-cache";
import type { Infrastructure, Layer, Provider } from "./types";

type Rule = { name: string; layer: "edge" | "host" } & (
	{ hostname: RegExp; label: string } | { header: string; value?: RegExp }
);

// Only provider-specific signals. Generic headers (via, x-cache, etag) are ignored.
const RULES: readonly Rule[] = [
	{ name: "Cloudflare Pages", layer: "host", hostname: /\.pages\.dev$/, label: "pages.dev" },
	{ name: "Vercel", layer: "host", hostname: /\.vercel\.app$/, label: "vercel.app" },
	{ name: "Netlify", layer: "host", hostname: /\.netlify\.app$/, label: "netlify.app" },
	{ name: "GitHub Pages", layer: "host", hostname: /\.github\.io$/, label: "github.io" },
	{
		name: "AWS S3",
		layer: "host",
		hostname: /(^|\.)s3(-website)?[.-][a-z0-9-]+\.amazonaws\.com(\.cn)?$|\.s3\.amazonaws\.com$/,
		label: "S3 endpoint",
	},
	{
		name: "Google Cloud Storage",
		layer: "host",
		hostname: /(^|\.)storage\.googleapis\.com$/,
		label: "storage.googleapis.com",
	},
	{
		name: "Azure Blob Storage",
		layer: "host",
		hostname: /\.(web\.core\.windows\.net|web\.storage\.azure\.net|blob\.core\.windows\.net)$/,
		label: "Azure storage",
	},
	{
		name: "Azure Static Web Apps",
		layer: "host",
		hostname: /\.azurestaticapps\.net$/,
		label: "azurestaticapps.net",
	},
	{ name: "Azure", layer: "host", hostname: /\.azurewebsites\.net$/, label: "azurewebsites.net" },
	{ name: "Fly.io", layer: "host", hostname: /\.fly\.dev$/, label: "fly.dev" },
	{ name: "Render", layer: "host", hostname: /\.onrender\.com$/, label: "onrender.com" },
	{ name: "Google Cloud", layer: "host", hostname: /\.run\.app$/, label: "run.app" },
	{
		name: "Firebase",
		layer: "host",
		hostname: /\.(web\.app|firebaseapp\.com)$/,
		label: "Firebase",
	},
	{ name: "Heroku", layer: "host", hostname: /\.herokuapp\.com$/, label: "herokuapp.com" },
	{ name: "Railway", layer: "host", hostname: /\.railway\.app$/, label: "railway.app" },
	{
		name: "DigitalOcean",
		layer: "host",
		hostname: /\.ondigitalocean\.app$/,
		label: "ondigitalocean.app",
	},
	{ name: "Shopify", layer: "host", hostname: /\.myshopify\.com$/, label: "myshopify.com" },
	{ name: "Webflow", layer: "host", hostname: /\.webflow\.io$/, label: "webflow.io" },
	{ name: "Framer", layer: "host", hostname: /\.framer\.(app|website)$/, label: "Framer" },
	{ name: "GitBook", layer: "host", hostname: /\.gitbook\.io$/, label: "gitbook.io" },
	{ name: "ReadMe", layer: "host", hostname: /\.readme\.io$/, label: "readme.io" },
	{ name: "Mintlify", layer: "host", hostname: /\.mintlify\.(app|dev)$/, label: "Mintlify" },

	{ name: "Cloudflare", layer: "edge", header: "cf-ray" },
	{ name: "Cloudflare", layer: "edge", header: "server", value: /^cloudflare$/i },
	{ name: "Vercel", layer: "edge", header: "server", value: /^vercel$/i },
	{ name: "Vercel", layer: "host", header: "x-vercel-id" },
	{ name: "Netlify", layer: "edge", header: "server", value: /^netlify/i },
	{ name: "Netlify", layer: "host", header: "x-nf-request-id" },
	{ name: "AWS CloudFront", layer: "edge", header: "x-amz-cf-id" },
	{ name: "AWS S3", layer: "host", header: "server", value: /^AmazonS3$/i },
	{ name: "Google Cloud Storage", layer: "host", header: "x-goog-generation" },
	{
		name: "Azure Blob Storage",
		layer: "host",
		header: "server",
		value: /^Windows-Azure-Blob(\/|$)/i,
	},
	{ name: "Fastly", layer: "edge", header: "x-served-by", value: /cache-[a-z0-9-]+/i },
	{ name: "Fastly", layer: "edge", header: "x-fastly-request-id" },
	// Present on every GitHub property, not just Pages; github.io hostnames identify Pages.
	{ name: "GitHub", layer: "host", header: "x-github-request-id" },
	{ name: "Fly.io", layer: "host", header: "fly-request-id" },
	{ name: "Render", layer: "host", header: "x-render-origin-server" },
	{ name: "Render", layer: "host", header: "rndr-id" },
	{
		name: "Google Cloud",
		layer: "edge",
		header: "server",
		value: /^(gws|ESF|Google Frontend|sffe)$/i,
	},
	{ name: "Firebase", layer: "host", header: "x-served-by", value: /firebase/i },
	{ name: "Azure", layer: "edge", header: "x-azure-ref" },
	{ name: "Akamai", layer: "edge", header: "server", value: /AkamaiGHost|AkamaiNetStorage/i },
	{ name: "Akamai", layer: "edge", header: "x-akamai-transformed" },
	{ name: "Akamai", layer: "edge", header: "x-akamai-request-id" },
	{ name: "Heroku", layer: "host", header: "via", value: /heroku-router/i },
	{ name: "Railway", layer: "host", header: "x-railway-request-id" },
	{ name: "Shopify", layer: "host", header: "x-shopid" },
	{ name: "Squarespace", layer: "host", header: "server", value: /squarespace/i },
	{ name: "Wix", layer: "host", header: "x-wix-request-id" },
	{ name: "Framer", layer: "host", header: "x-framer-request-id" },
	{ name: "Discourse", layer: "host", header: "x-discourse-route" },
	{ name: "Ghost", layer: "host", header: "x-ghost-cache-status" },
	{ name: "HubSpot", layer: "host", header: "x-hs-hub-id" },
	{ name: "Substack", layer: "host", header: "x-served-by-substack" },
	{ name: "GitBook", layer: "host", header: "x-gitbook-site" },
	{ name: "ReadMe", layer: "host", header: "x-readme-cache" },
	{ name: "Mintlify", layer: "host", header: "x-mintlify-cache" },
];

export const PROVIDER_NAMES = [
	...new Set([...RULES.map((rule) => rule.name), "Azure Front Door", "Azure App Service"]),
];

type Match = {
	name: string;
	layer: "edge" | "host";
	source: "hostname" | "header";
	evidence: string;
};

/** Classifies edge and host from the final response and its hostname. */
export function detectInfrastructure(
	headers: Headers,
	url: string,
	dnsProviders: DnsProviders = { edge: [], host: [] },
): Infrastructure {
	const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
	const matches: Match[] = [];
	for (const rule of RULES) {
		if ("hostname" in rule) {
			if (rule.hostname.test(hostname)) {
				matches.push({ ...rule, source: "hostname", evidence: `${rule.label} hostname` });
			}
			continue;
		}
		const value = headers.get(rule.header);
		if (value !== null && (!rule.value || rule.value.test(value))) {
			matches.push({ ...rule, source: "header", evidence: `${rule.header} header` });
		}
	}

	const edge = mergeProviders(matches.filter((match) => match.layer === "edge"));
	let hostMatches = matches.filter((match) => match.layer === "host");
	// A platform hostname (x.vercel.app) outranks headers, which proxies can pass through.
	if (hostMatches.some((match) => match.source === "hostname")) {
		hostMatches = hostMatches.filter((match) => match.source === "hostname");
	}
	const host = mergeProviders(hostMatches);
	if (host.length > 1) for (const provider of host) provider.confidence = "likely";

	const edgeProviders = edge.length > 0 ? edge : dnsProviders.edge;
	const hostProviders = host.length > 0 ? host : dnsProviders.host;
	return {
		edge: layer(edgeProviders, "unknown"),
		host: layer(hostProviders, edgeProviders.length > 0 ? "hidden" : "unknown"),
	};
}

function mergeProviders(matches: Match[]): Provider[] {
	const byName = new Map<string, Provider>();
	for (const match of matches) {
		const provider = byName.get(match.name) ?? {
			name: match.name,
			confidence: "confirmed",
			evidence: [],
		};
		provider.evidence.push(match.evidence);
		byName.set(match.name, provider);
	}
	return [...byName.values()];
}

function layer(providers: Provider[], fallback: "hidden" | "unknown"): Layer {
	return providers.length > 0 ? { status: "identified", providers } : { status: fallback };
}

export type DnsProviders = { edge: Provider[]; host: Provider[] };

const DNS_TTL_MS = 24 * 60 * 60_000;
const DNS_TIMEOUT_MS = 1_500;

/**
 * Azure Front Door and App Service leave custom-domain validation TXT records
 * behind. They are the only signal for those origins, so they are "likely".
 */
export function lookupDnsProviders(
	url: string,
	fetch: typeof globalThis.fetch,
): Promise<DnsProviders> {
	const hostname = new URL(url).hostname.toLowerCase();
	return cached(dnsCache, hostname, DNS_TTL_MS, async () => {
		const [frontDoor, appService] = await Promise.all([
			hasTxtRecord(`_dnsauth.${hostname}`, fetch),
			hasTxtRecord(`asuid.${hostname}`, fetch),
		]);
		const likely = (name: string, evidence: string): Provider => ({
			name,
			confidence: "likely",
			evidence: [evidence],
		});
		return {
			edge: frontDoor ? [likely("Azure Front Door", "_dnsauth TXT record")] : [],
			host: appService ? [likely("Azure App Service", "asuid TXT record")] : [],
		};
	});
}

const dnsCache = new Map<string, { expiresAt: number; value: Promise<DnsProviders> }>();

async function hasTxtRecord(name: string, fetch: typeof globalThis.fetch): Promise<boolean> {
	const query = `https://cloudflare-dns.com/dns-query?type=TXT&name=${encodeURIComponent(name)}`;
	try {
		const response = await fetch(query, {
			headers: { Accept: "application/dns-json" },
			signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
		});
		if (!response.ok) return false;
		const body: unknown = JSON.parse(await readTextWithLimit(response, 64_000));
		return isDnsAnswerList(body) && body.Answer.some((answer) => answer.type === 16);
	} catch {
		return false;
	}
}

function isDnsAnswerList(value: unknown): value is { Answer: { type: unknown }[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"Answer" in value &&
		Array.isArray(value.Answer) &&
		value.Answer.every(
			(answer: unknown) => typeof answer === "object" && answer !== null && "type" in answer,
		)
	);
}
