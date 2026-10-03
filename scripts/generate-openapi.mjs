import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** @type {unknown} */
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
if (
	typeof packageJson !== "object" ||
	packageJson === null ||
	!("version" in packageJson) ||
	typeof packageJson.version !== "string"
) {
	throw new TypeError("package.json must contain a string version");
}
const outputPath = path.join(projectRoot, "public", "openapi.json");

/** @param {Record<string, unknown>} schema */
const jsonContent = (schema) => ({
	"application/json": { schema },
});

/**
 * @param {string[]} required
 * @param {Record<string, unknown>} properties
 */
const object = (required, properties) => ({
	type: "object",
	additionalProperties: false,
	required,
	properties,
});

const spec = {
	openapi: "3.1.0",
	info: {
		title: "isAstro JSON API",
		version: packageJson.version,
		description:
			"Check whether a public website exposes evidence that it was built with Astro or Starlight.",
	},
	servers: [{ url: "/" }],
	paths: {
		"/api": {
			get: {
				operationId: "checkWebsite",
				summary: "Check a website for Astro and Starlight",
				parameters: [
					{
						name: "url",
						in: "query",
						required: true,
						description:
							"A public website URL or hostname. HTTPS is added when no protocol is provided.",
						schema: { type: "string", minLength: 1 },
						examples: {
							hostname: { value: "astro.build" },
							url: { value: "https://astro.build/" },
						},
					},
				],
				responses: {
					200: {
						description:
							"The check ran. Inspect verdict.status: a site that blocked us or was down is still a 200.",
						content: jsonContent({ $ref: "#/components/schemas/Check" }),
					},
					400: {
						description: "The url query parameter is missing or not a public website URL",
						content: jsonContent({ $ref: "#/components/schemas/ApiError" }),
					},
				},
			},
			options: {
				operationId: "checkWebsiteOptions",
				summary: "CORS preflight",
				responses: {
					204: { description: "Preflight accepted" },
				},
			},
		},
	},
	components: {
		schemas: {
			Check: {
				type: "object",
				additionalProperties: false,
				required: ["url", "finalUrl", "verdict", "infrastructure"],
				properties: {
					url: { type: "string", format: "uri" },
					finalUrl: { type: "string", format: "uri", description: "URL after redirects" },
					verdict: { $ref: "#/components/schemas/Verdict" },
					infrastructure: { $ref: "#/components/schemas/Infrastructure" },
					showcase: {
						type: "object",
						description: "Only present for Astro sites",
						additionalProperties: false,
						properties: {
							astro: { $ref: "#/components/schemas/ShowcaseStatus" },
							starlight: { $ref: "#/components/schemas/ShowcaseStatus" },
						},
					},
				},
			},
			Verdict: {
				oneOf: [
					object(["status", "starlight", "evidence"], {
						status: { const: "astro" },
						starlight: { type: "boolean" },
						astroVersion: { type: "string" },
						starlightVersion: { type: "string" },
						starlightEvidence: { type: "array", items: { type: "string" } },
						evidence: { type: "array", items: { type: "string" } },
					}),
					object(["status"], { status: { const: "not-astro" } }),
					object(["status", "by"], {
						status: { const: "blocked" },
						by: { enum: ["cloudflare", "vercel", "sgcaptcha", "unknown"] },
					}),
					object(["status", "reason"], {
						status: { const: "unreachable" },
						reason: {
							enum: [
								"timeout",
								"network-error",
								"http-error",
								"not-html",
								"empty-body",
								"too-large",
								"too-many-redirects",
								"disallowed-redirect",
							],
						},
						httpStatus: { type: "integer" },
						cloudflareError: {
							type: "integer",
							description: "Cloudflare's 1xxx error code, when Cloudflare served the error page",
						},
					}),
				],
			},
			Infrastructure: object(["providers", "headers"], {
				providers: {
					type: "array",
					description:
						"Providers named by signals only they emit. CDNs first; a CDN usually hides the host.",
					items: object(["name", "role", "evidence"], {
						name: { type: "string" },
						role: { enum: ["cdn", "hosting"] },
						evidence: {
							type: "array",
							description:
								'Each signal seen, e.g. "cf-ray: 8f1a2b3c-EWR" or "hostname x.pages.dev"',
							items: { type: "string" },
						},
					}),
				},
				headers: {
					type: "array",
					description:
						"Raw serving and caching response headers, including every header cited as evidence",
					items: object(["name", "value"], { name: { type: "string" }, value: { type: "string" } }),
				},
			}),
			ShowcaseStatus: {
				oneOf: [
					object(["listed"], { listed: { const: false } }),
					object(["listed", "title", "url"], {
						listed: { const: true },
						title: { type: "string" },
						url: { type: "string", format: "uri" },
					}),
				],
			},
			ApiError: object(["error"], { error: { type: "string" }, url: { type: "string" } }),
		},
	},
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
stdout.write(`Wrote ${path.relative(projectRoot, outputPath)}\n`);
