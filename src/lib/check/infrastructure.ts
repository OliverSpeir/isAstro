import type { Origin } from "./network";
import type { Infrastructure, Provider } from "./types";

type Rule = { name: string; role: Provider["role"] } & (
	{ hostname: RegExp } | { header: string; value?: RegExp }
);

// Only signals that a single provider emits. Generic headers (server: nginx,
// via, etag) are reported as raw headers instead, never mapped to a provider.
const RULES: readonly Rule[] = [
	{ name: "Cloudflare", role: "cdn", header: "cf-ray" },
	{ name: "Cloudflare", role: "cdn", header: "server", value: /^cloudflare$/i },
	{ name: "AWS CloudFront", role: "cdn", header: "x-amz-cf-id" },
	{ name: "AWS CloudFront", role: "cdn", header: "server", value: /^CloudFront$/i },
	{ name: "Fastly", role: "cdn", header: "x-served-by", value: /^cache-/i },
	{ name: "Fastly", role: "cdn", header: "x-fastly-request-id" },
	{ name: "Akamai", role: "cdn", header: "server", value: /^(AkamaiGHost|AkamaiNetStorage)/i },
	{ name: "Akamai", role: "cdn", header: "x-akamai-transformed" },
	{ name: "Akamai", role: "cdn", header: "x-akamai-request-id" },
	{ name: "Azure Front Door", role: "cdn", header: "x-azure-ref" },
	{
		name: "Google Front End",
		role: "cdn",
		header: "server",
		value: /^(gws|ESF|Google Frontend|sffe)$/i,
	},
	{ name: "Bunny CDN", role: "cdn", header: "server", value: /^BunnyCDN/i },
	{ name: "Hostinger CDN", role: "cdn", header: "x-hcdn-request-id" },
	{ name: "Hostinger CDN", role: "cdn", header: "server", value: /^hcdn$/i },
	// Both platforms name their own edge cache on every response it serves.
	{ name: "Netlify", role: "cdn", header: "cache-status", value: /"Netlify Edge"/i },
	{ name: "Vercel", role: "cdn", header: "x-vercel-cache" },

	{ name: "Cloudflare Pages", role: "hosting", hostname: /\.pages\.dev$/ },
	{ name: "Cloudflare Workers", role: "hosting", hostname: /\.workers\.dev$/ },
	{ name: "Vercel", role: "hosting", hostname: /\.vercel\.app$/ },
	{ name: "Vercel", role: "hosting", header: "x-vercel-id" },
	{ name: "Vercel", role: "hosting", header: "server", value: /^Vercel$/i },
	{ name: "Netlify", role: "hosting", hostname: /\.netlify\.app$/ },
	{ name: "Netlify", role: "hosting", header: "x-nf-request-id" },
	{ name: "Netlify", role: "hosting", header: "server", value: /^Netlify/i },
	{ name: "GitHub Pages", role: "hosting", hostname: /\.github\.io$/ },
	// github.com itself sends "server: github.com"; only Pages capitalises it.
	{ name: "GitHub Pages", role: "hosting", header: "server", value: /^GitHub\.com$/ },
	{
		name: "AWS S3",
		role: "hosting",
		hostname: /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com(\.cn)?$/,
	},
	{ name: "AWS S3", role: "hosting", header: "server", value: /^AmazonS3$/i },
	{ name: "AWS S3", role: "hosting", header: "x-amz-version-id" },
	{ name: "Google Cloud Storage", role: "hosting", hostname: /(^|\.)storage\.googleapis\.com$/ },
	{ name: "Google Cloud Storage", role: "hosting", header: "x-goog-generation" },
	{ name: "Google Cloud Run", role: "hosting", hostname: /\.run\.app$/ },
	{ name: "Google Cloud", role: "hosting", header: "x-cloud-trace-context" },
	{ name: "Firebase", role: "hosting", hostname: /\.(web\.app|firebaseapp\.com)$/ },
	{
		name: "Azure Blob Storage",
		role: "hosting",
		hostname: /\.(web|blob)\.core\.windows\.net$|\.web\.storage\.azure\.net$/,
	},
	{
		name: "Azure Blob Storage",
		role: "hosting",
		header: "server",
		value: /^Windows-Azure-Blob(\/|$)/i,
	},
	{ name: "Azure Static Web Apps", role: "hosting", hostname: /\.azurestaticapps\.net$/ },
	{ name: "Azure App Service", role: "hosting", hostname: /\.azurewebsites\.net$/ },
	{ name: "Fly.io", role: "hosting", hostname: /\.fly\.dev$/ },
	{ name: "Fly.io", role: "hosting", header: "fly-request-id" },
	{ name: "Render", role: "hosting", hostname: /\.onrender\.com$/ },
	{ name: "Render", role: "hosting", header: "x-render-origin-server" },
	{ name: "Render", role: "hosting", header: "rndr-id" },
	{ name: "Heroku", role: "hosting", hostname: /\.herokuapp\.com$/ },
	{ name: "Heroku", role: "hosting", header: "via", value: /heroku-router/i },
	{ name: "Railway", role: "hosting", hostname: /\.railway\.app$/ },
	{ name: "Railway", role: "hosting", header: "x-railway-request-id" },
	{ name: "DigitalOcean App Platform", role: "hosting", hostname: /\.ondigitalocean\.app$/ },
	{ name: "DigitalOcean App Platform", role: "hosting", header: "x-do-app-origin" },
	{ name: "Shopify", role: "hosting", hostname: /\.myshopify\.com$/ },
	{ name: "Shopify", role: "hosting", header: "x-shopid" },
	{ name: "Webflow", role: "hosting", hostname: /\.webflow\.io$/ },
	{ name: "Framer", role: "hosting", hostname: /\.framer\.(app|website)$/ },
	{ name: "Framer", role: "hosting", header: "x-framer-request-id" },
	{ name: "Squarespace", role: "hosting", header: "server", value: /^Squarespace$/i },
	{ name: "Wix", role: "hosting", header: "x-wix-request-id" },
	{ name: "Discourse", role: "hosting", header: "x-discourse-route" },
	{ name: "Ghost", role: "hosting", header: "x-ghost-cache-status" },
	{ name: "HubSpot", role: "hosting", header: "x-hs-hub-id" },
	{ name: "Substack", role: "hosting", header: "x-served-by-substack" },
	{ name: "GitBook", role: "hosting", hostname: /\.gitbook\.io$/ },
	{ name: "GitBook", role: "hosting", header: "x-gitbook-site" },
	{ name: "ReadMe", role: "hosting", hostname: /\.readme\.io$/ },
	{ name: "ReadMe", role: "hosting", header: "x-readme-cache" },
	{ name: "Mintlify", role: "hosting", hostname: /\.mintlify\.(app|dev)$/ },
	{ name: "Mintlify", role: "hosting", header: "x-mintlify-cache" },
];

/** Shown as-is: they describe the server and caching but don't identify a provider. */
const DESCRIPTIVE_HEADERS = [
	"server",
	"via",
	"x-powered-by",
	"cache-control",
	"age",
	"cf-cache-status",
	"x-vercel-cache",
	"cache-status",
	"x-cache",
];
const MAX_VALUE_LENGTH = 120;

export const PROVIDER_NAMES = [...new Set(RULES.map((rule) => rule.name))];

/** Lists the providers the final response, hostname or address identify, citing each signal. */
export function detectInfrastructure(
	{ headers, cloudflareAddress }: Origin,
	url: string,
): Infrastructure {
	const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
	const providers = new Map<string, Provider>();
	const citedHeaders = new Set<string>();
	if (cloudflareAddress) {
		providers.set("cdn:Cloudflare", {
			name: "Cloudflare",
			role: "cdn",
			evidence: [`address ${cloudflareAddress} on Cloudflare's network`],
		});
	}

	for (const rule of RULES) {
		let evidence: string | undefined;
		if ("hostname" in rule) {
			if (rule.hostname.test(hostname)) evidence = `hostname ${hostname}`;
		} else {
			const value = headers.get(rule.header);
			if (value !== null && (!rule.value || rule.value.test(value))) {
				evidence = `${rule.header}: ${value.slice(0, MAX_VALUE_LENGTH)}`;
				citedHeaders.add(rule.header);
			}
		}
		if (!evidence) continue;
		// Keyed by role too: Netlify and Vercel can be both the CDN and the host.
		const key = `${rule.role}:${rule.name}`;
		const provider = providers.get(key) ?? { name: rule.name, role: rule.role, evidence: [] };
		provider.evidence.push(evidence);
		providers.set(key, provider);
	}

	const headerNames = [...new Set([...DESCRIPTIVE_HEADERS, ...citedHeaders])];
	return {
		providers: [...providers.values()].sort((left, right) =>
			left.role === right.role ? 0 : left.role === "cdn" ? -1 : 1,
		),
		headers: headerNames.flatMap((name) => {
			const value = headers.get(name);
			return value === null ? [] : [{ name, value: value.slice(0, MAX_VALUE_LENGTH) }];
		}),
	};
}
