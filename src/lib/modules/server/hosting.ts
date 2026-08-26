import { readResponseTextWithLimit } from "./response";

export type InfrastructureLayer = "edge" | "hosting";

export type InfrastructureProvider = {
	name: string;
	layer: InfrastructureLayer;
	evidence: string;
	confidence?: "likely";
};

type HeaderRule = {
	name: string;
	layer: InfrastructureLayer;
	header: string;
	value?: RegExp;
};

type HostnameRule = {
	name: string;
	layer: InfrastructureLayer;
	suffixes?: readonly string[];
	patterns?: readonly RegExp[];
	evidence?: string;
};

type DnsJsonAnswer = { type?: number; data?: string };
type DnsJsonResponse = { Answer?: DnsJsonAnswer[] };

const DNS_CACHE_TTL_MS = 24 * 60 * 60_000;
const DNS_CACHE_MAX_ENTRIES = 256;
const DNS_FETCH_TIMEOUT_MS = 1_500;
const MAX_DNS_RESPONSE_BYTES = 64_000;
const dnsInfrastructureCache = new Map<
	string,
	{ expiresAt: number; providers: InfrastructureProvider[] }
>();
const dnsInfrastructureInFlight = new Map<string, Promise<InfrastructureProvider[]>>();

const HOSTNAME_RULES: readonly HostnameRule[] = [
	{ name: "Cloudflare Pages", layer: "hosting", suffixes: ["pages.dev"] },
	{ name: "Vercel", layer: "hosting", suffixes: ["vercel.app"] },
	{ name: "Netlify", layer: "hosting", suffixes: ["netlify.app"] },
	{ name: "GitHub Pages", layer: "hosting", suffixes: ["github.io"] },
	{
		name: "AWS S3",
		layer: "hosting",
		suffixes: ["s3.amazonaws.com"],
		patterns: [/(?:^|\.)s3(?:-website)?[.-][a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/i],
		evidence: "S3 endpoint hostname",
	},
	{
		name: "Google Cloud Storage",
		layer: "hosting",
		suffixes: ["storage.googleapis.com"],
	},
	{
		name: "Azure Blob Storage",
		layer: "hosting",
		suffixes: ["web.core.windows.net", "web.storage.azure.net", "blob.core.windows.net"],
	},
	{ name: "Fly.io", layer: "hosting", suffixes: ["fly.dev"] },
	{ name: "Render", layer: "hosting", suffixes: ["onrender.com"] },
	{ name: "Google Cloud", layer: "hosting", suffixes: ["run.app"] },
	{ name: "Firebase", layer: "hosting", suffixes: ["web.app", "firebaseapp.com"] },
	{ name: "Azure", layer: "hosting", suffixes: ["azurewebsites.net"] },
	{
		name: "Azure Static Web Apps",
		layer: "hosting",
		suffixes: ["azurestaticapps.net"],
	},
	{ name: "Heroku", layer: "hosting", suffixes: ["herokuapp.com"] },
	{ name: "Railway", layer: "hosting", suffixes: ["railway.app"] },
	{ name: "DigitalOcean", layer: "hosting", suffixes: ["ondigitalocean.app"] },
	{ name: "Shopify", layer: "hosting", suffixes: ["myshopify.com"] },
	{ name: "Webflow", layer: "hosting", suffixes: ["webflow.io"] },
	{ name: "Framer", layer: "hosting", suffixes: ["framer.app", "framer.website"] },
	{ name: "GitBook", layer: "hosting", suffixes: ["gitbook.io"] },
	{ name: "ReadMe", layer: "hosting", suffixes: ["readme.io"] },
	{ name: "Mintlify", layer: "hosting", suffixes: ["mintlify.app", "mintlify.dev"] },
];

// These deliberately use only provider-specific, high-confidence response headers.
// Generic headers and DNS guesses are excluded to avoid misleading results.
const HEADER_RULES: readonly HeaderRule[] = [
	{ name: "Cloudflare", layer: "edge", header: "cf-ray" },
	{ name: "Cloudflare", layer: "edge", header: "server", value: /^cloudflare$/i },
	{ name: "Vercel", layer: "hosting", header: "x-vercel-id" },
	{ name: "Vercel", layer: "edge", header: "server", value: /^vercel$/i },
	{ name: "Netlify", layer: "hosting", header: "x-nf-request-id" },
	{ name: "Netlify", layer: "edge", header: "server", value: /^netlify/i },
	{ name: "AWS CloudFront", layer: "edge", header: "x-amz-cf-id" },
	{ name: "AWS S3", layer: "hosting", header: "server", value: /^AmazonS3$/i },
	{ name: "Google Cloud Storage", layer: "hosting", header: "x-goog-generation" },
	{
		name: "Azure Blob Storage",
		layer: "hosting",
		header: "server",
		value: /^Windows-Azure-Blob(?:\/|$)/i,
	},
	{ name: "Fastly", layer: "edge", header: "x-served-by", value: /cache-[a-z0-9-]+/i },
	{ name: "GitHub Pages", layer: "hosting", header: "x-github-request-id" },
	{ name: "Fly.io", layer: "hosting", header: "fly-request-id" },
	{ name: "Render", layer: "hosting", header: "x-render-origin-server" },
	{ name: "Render", layer: "hosting", header: "rndr-id" },
	{
		name: "Google Cloud",
		layer: "edge",
		header: "server",
		value: /^(gws|ESF|Google Frontend|sffe)$/i,
	},
	{ name: "Firebase", layer: "hosting", header: "x-served-by", value: /firebase/i },
	{ name: "Azure", layer: "edge", header: "x-azure-ref" },
	{ name: "Akamai", layer: "edge", header: "server", value: /AkamaiGHost|AkamaiNetStorage/i },
	{ name: "Akamai", layer: "edge", header: "x-akamai-transformed" },
	{ name: "Akamai", layer: "edge", header: "x-akamai-request-id" },
	{ name: "Heroku", layer: "hosting", header: "via", value: /heroku-router/i },
	{ name: "Railway", layer: "hosting", header: "x-railway-request-id" },
	{ name: "Shopify", layer: "hosting", header: "x-shopify-stage" },
	{ name: "Shopify", layer: "hosting", header: "x-shopid" },
	{ name: "Squarespace", layer: "hosting", header: "server", value: /squarespace/i },
	{ name: "Wix", layer: "hosting", header: "x-wix-request-id" },
	{ name: "Framer", layer: "hosting", header: "x-framer-request-id" },
	{ name: "Discourse", layer: "hosting", header: "x-discourse-route" },
	{ name: "Ghost", layer: "hosting", header: "x-ghost-cache-status" },
	{ name: "HubSpot", layer: "hosting", header: "x-hs-hub-id" },
	{ name: "Substack", layer: "hosting", header: "x-served-by-substack" },
	{ name: "GitBook", layer: "hosting", header: "x-gitbook-site" },
	{ name: "ReadMe", layer: "hosting", header: "x-readme-cache" },
	{ name: "Mintlify", layer: "hosting", header: "x-mintlify-cache" },
];

export const INFRASTRUCTURE_PROVIDER_NAMES = [
	...new Set([
		...[...HOSTNAME_RULES, ...HEADER_RULES].map((rule) => rule.name),
		"Azure Front Door",
		"Azure App Service",
	]),
];

export function clearDnsInfrastructureCache(): void {
	dnsInfrastructureCache.clear();
	dnsInfrastructureInFlight.clear();
}

function pruneDnsInfrastructureCache(now: number): void {
	for (const [hostname, entry] of dnsInfrastructureCache) {
		if (entry.expiresAt <= now) dnsInfrastructureCache.delete(hostname);
	}
	while (dnsInfrastructureCache.size >= DNS_CACHE_MAX_ENTRIES) {
		const oldestHostname = dnsInfrastructureCache.keys().next().value;
		if (!oldestHostname) break;
		dnsInfrastructureCache.delete(oldestHostname);
	}
}

async function queryDnsTxt(
	name: string,
	fetchImplementation: typeof globalThis.fetch,
): Promise<boolean> {
	const query = new URL("https://cloudflare-dns.com/dns-query");
	query.searchParams.set("name", name);
	query.searchParams.set("type", "TXT");
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, DNS_FETCH_TIMEOUT_MS);
	try {
		const requestInit: RequestInit & { cf?: { cacheEverything: boolean; cacheTtl: number } } = {
			headers: { Accept: "application/dns-json" },
			signal: controller.signal,
			cf: { cacheEverything: true, cacheTtl: 86_400 },
		};
		const response = await fetchImplementation(query, requestInit);
		if (!response.ok) return false;
		const body = await readResponseTextWithLimit(
			response,
			MAX_DNS_RESPONSE_BYTES,
			"DNS response was too large",
		);
		const value = JSON.parse(body) as DnsJsonResponse;
		return value.Answer?.some(
			(answer) => answer.type === 16 && typeof answer.data === "string" && answer.data.length > 2,
		) ?? false;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

export async function detectDnsInfrastructure(
	target: string | URL,
	fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<InfrastructureProvider[]> {
	let hostname: string;
	try {
		hostname = new URL(target).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return [];
	}

	const now = Date.now();
	const cached = dnsInfrastructureCache.get(hostname);
	if (cached && cached.expiresAt > now) {
		dnsInfrastructureCache.delete(hostname);
		dnsInfrastructureCache.set(hostname, cached);
		return cached.providers;
	}
	if (cached) dnsInfrastructureCache.delete(hostname);
	const existing = dnsInfrastructureInFlight.get(hostname);
	if (existing) return existing;

	const request = Promise.all([
		queryDnsTxt(`_dnsauth.${hostname}`, fetchImplementation),
		queryDnsTxt(`asuid.${hostname}`, fetchImplementation),
	])
		.then(([hasFrontDoorValidation, hasAppServiceValidation]) => {
			const providers: InfrastructureProvider[] = [];
			if (hasFrontDoorValidation) {
				providers.push({
					name: "Azure Front Door",
					layer: "edge",
					evidence: "_dnsauth TXT record",
					confidence: "likely",
				});
			}
			if (hasAppServiceValidation) {
				providers.push({
					name: "Azure App Service",
					layer: "hosting",
					evidence: "asuid TXT record",
					confidence: "likely",
				});
			}
			pruneDnsInfrastructureCache(Date.now());
			dnsInfrastructureCache.set(hostname, {
				expiresAt: Date.now() + DNS_CACHE_TTL_MS,
				providers,
			});
			return providers;
		})
		.finally(() => dnsInfrastructureInFlight.delete(hostname));
	dnsInfrastructureInFlight.set(hostname, request);
	return request;
}

export function sortInfrastructureProviders(
	providers: readonly InfrastructureProvider[],
): InfrastructureProvider[] {
	const layerOrder: Record<InfrastructureLayer, number> = { edge: 0, hosting: 1 };
	return [...providers].sort(
		(left, right) => layerOrder[left.layer] - layerOrder[right.layer],
	);
}

export function detectInfrastructure(
	headers: Headers,
	target?: string | URL,
): InfrastructureProvider[] {
	const providers: InfrastructureProvider[] = [];
	const detected = new Set<string>();
	const hostnameHostingProviders = new Set<string>();
	const addProvider = (provider: InfrastructureProvider): void => {
		const key = `${provider.layer}:${provider.name}`;
		if (detected.has(key)) return;
		detected.add(key);
		providers.push(provider);
	};

	if (target) {
		let hostname: string | undefined;
		try {
			hostname = new URL(target).hostname.toLowerCase().replace(/\.$/, "");
		} catch {
			// The request target was already validated; keep this helper safe for direct callers.
		}
		if (hostname) {
			for (const rule of HOSTNAME_RULES) {
				const suffix = rule.suffixes?.find(
					(value) => hostname === value || hostname.endsWith(`.${value}`),
				);
				const matchesPattern = rule.patterns?.some((pattern) => pattern.test(hostname)) ?? false;
				if (!suffix && !matchesPattern) continue;
				addProvider({
					name: rule.name,
					layer: rule.layer,
					evidence: rule.evidence ?? `${suffix ?? hostname} hostname`,
				});
				if (rule.layer === "hosting") hostnameHostingProviders.add(rule.name);
			}
		}
	}

	for (const rule of HEADER_RULES) {
		const value = headers.get(rule.header);
		if (value === null || (rule.value && !rule.value.test(value))) continue;
		addProvider({
			name: rule.name,
			layer: rule.layer,
			evidence: `${rule.header} response header`,
			confidence: "likely",
		});
	}

	// A pages.dev hostname identifies a Cloudflare Pages deployment, which
	// independently corroborates the Cloudflare edge response headers.
	if (hostnameHostingProviders.has("Cloudflare Pages")) {
		const cloudflareEdge = providers.find(
			(provider) => provider.layer === "edge" && provider.name === "Cloudflare",
		);
		if (cloudflareEdge) delete cloudflareEdge.confidence;
	}

	const hostingProviders = providers.filter((provider) => provider.layer === "hosting");
	if (hostingProviders.length > 1) {
		const hostnameMatches = hostingProviders.filter((provider) =>
			hostnameHostingProviders.has(provider.name),
		);
		const trustedHostingNames = new Set(hostnameMatches.map((provider) => provider.name));
		for (let index = providers.length - 1; index >= 0; index--) {
			const provider = providers[index];
			if (
				provider?.layer === "hosting" &&
				(hostnameMatches.length === 0 || !trustedHostingNames.has(provider.name))
			) {
				providers.splice(index, 1);
			}
		}
	}

	return sortInfrastructureProviders(providers);
}
