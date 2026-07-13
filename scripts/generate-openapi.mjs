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
						description: "Detection completed",
						content: jsonContent({ $ref: "#/components/schemas/DetectionResult" }),
					},
					400: {
						description: "The URL query parameter is missing or invalid",
						content: jsonContent({ $ref: "#/components/schemas/ApiError" }),
					},
					502: {
						description: "The target website could not be checked",
						content: jsonContent({ $ref: "#/components/schemas/DetectionFailure" }),
					},
					504: {
						description: "The target website did not respond before the deadline",
						content: jsonContent({ $ref: "#/components/schemas/DetectionFailure" }),
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
			DetectionResult: {
				type: "object",
				additionalProperties: false,
				required: ["url", "lastFetchedUrl", "isAstro", "isStarlight", "mechanism"],
				properties: {
					url: { type: "string", format: "uri" },
					lastFetchedUrl: { type: "string", format: "uri" },
					isAstro: { type: "boolean" },
					isStarlight: { type: "boolean" },
					mechanism: { type: "string" },
					astroVersion: { type: "string" },
					starlightVersion: { type: "string" },
				},
			},
			ApiError: {
				type: "object",
				additionalProperties: false,
				required: ["error"],
				properties: {
					error: { type: "string" },
					url: { type: "string" },
				},
			},
			DetectionFailure: {
				type: "object",
				additionalProperties: false,
				required: ["url", "isAstro", "isStarlight", "mechanism"],
				properties: {
					url: { type: "string", format: "uri" },
					lastFetchedUrl: { type: "string", format: "uri" },
					isAstro: { type: "boolean", const: false },
					isStarlight: { type: "boolean", const: false },
					mechanism: { type: "string" },
				},
			},
		},
	},
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
stdout.write(`Wrote ${path.relative(projectRoot, outputPath)}\n`);
