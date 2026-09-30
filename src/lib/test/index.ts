import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clearDetectionCache,
	CustomError,
	detectInfrastructure,
	getCachedAstroDetection,
	isAstroWebsite,
	isValidUrl,
} from "@modules/server";
import { checkWebsiteInput, normalizeWebsiteUrl } from "@modules/server/request";
import {
	clearDnsInfrastructureCache,
	detectDnsInfrastructure,
	INFRASTRUCTURE_PROVIDER_NAMES,
} from "@modules/server/hosting";
import { readResponseTextWithLimit } from "@modules/server/response";
import { providerIconIds } from "@lib/provider-icons";
import { clearShowcaseCache, findShowcaseSite, getShowcaseSites } from "@lib/showcase";
import {
	clearStarlightShowcaseCache,
	getStarlightShowcaseStatus,
	parseStarlightShowcase,
} from "@lib/starlight-showcase";
import { GET as getShowcaseJson } from "../../pages/showcase.json.ts";
import { createMockResponse, createSequenceFetch, type FetchCall } from "./utils";

const targetUrl = "https://example.com/";

void test("detects body markers after a closed head", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			"<!doctype html><html><head><title>Test</title></head><body>",
			"<div data-astro-cid-abcd>Some content</div></body></html>",
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, true);
	assert.match(result.mechanism, /data-astro/i);
});

void test("scans body bytes that share the closing-head chunk", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			'<!doctype html><html><head></head><body><astro-island component-url="/_astro/a.js"></astro-island></body></html>',
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, true);
	assert.match(result.mechanism, /astro-island|_astro/);
});

void test("detects split, reordered Astro and Starlight generator tags", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			'<!doctype html><html><head><meta content="Astro 5.1" na',
			'me="generator"><meta content="Starlight 0.30" name="generator"></head>',
			"<body></body></html>",
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, true);
	assert.equal(result.isStarlight, true);
	assert.equal(result.astroVersion, "5.1");
	assert.equal(result.starlightVersion, "0.30");
});

void test("treats a versionless Starlight generator as Astro", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			'<!doctype html><html><head><meta content="Starlight" name="generator"></head><body></body></html>',
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, true);
	assert.equal(result.isStarlight, true);
	assert.equal(result.starlightVersion, undefined);
});

void test("matches safe showcase URLs to the final site and listed path", async () => {
	const showcaseSites = [
		{ title: "Example Site", url: "https://example.com/featured/path", slug: "example.com" },
	];
	assert.equal(
		findShowcaseSite(["https://www.example.com/featured/path/page?query=1"], showcaseSites)?.title,
		"Example Site",
	);
	assert.equal(findShowcaseSite(["https://www.example.com/another/path"], showcaseSites), undefined);
	assert.equal(findShowcaseSite(["https://docs.example.com/"], showcaseSites), undefined);
	const githubPagesSites = [
		{
			title: "Featured project",
			url: "https://person.github.io/featured/",
			slug: "featured",
		},
	];
	assert.equal(
		findShowcaseSite(["https://person.github.io/featured/docs/"], githubPagesSites)?.title,
		"Featured project",
	);
	assert.equal(
		findShowcaseSite(["https://person.github.io/different/"], githubPagesSites),
		undefined,
	);

	clearShowcaseCache();
	const safeSites = await getShowcaseSites(() =>
		Promise.resolve(
			Response.json([
				{ title: "Unsafe", url: "javascript:alert(document.domain)", slug: "unsafe" },
				...showcaseSites,
			]),
		),
	);
	assert.deepEqual(safeSites, showcaseSites);

	clearDetectionCache();
	clearShowcaseCache();
	let showcaseFetches = 0;
	const showcaseFetch: typeof globalThis.fetch = () => {
		showcaseFetches++;
		return Promise.resolve(Response.json(showcaseSites));
	};
	const positive = await checkWebsiteInput("www.example.com/featured/path/page", {
		fetch: createSequenceFetch([
			createMockResponse(['<meta name="generator" content="Astro 5"></head>']),
		]),
		showcaseFetch,
		includeDnsInfrastructure: false,
	});
	assert.equal(positive.ok, true);
	assert.deepEqual(positive.result.showcase, {
		listed: true,
		title: "Example Site",
		url: "https://example.com/featured/path",
	});
	assert.equal(showcaseFetches, 1);

	clearDetectionCache();
	clearShowcaseCache();
	const redirected = await checkWebsiteInput("listed.example/open-redirect", {
		fetch: createSequenceFetch([
			new Response(null, {
				status: 302,
				headers: { Location: "https://attacker.example/" },
			}),
			createMockResponse(['<meta name="generator" content="Astro 5"></head>']),
		]),
		showcaseFetch: () =>
			Promise.resolve(
				Response.json([
					{ title: "Listed redirector", url: "https://listed.example/", slug: "listed" },
				]),
			),
		includeDnsInfrastructure: false,
	});
	assert.equal(redirected.ok, true);
	assert.deepEqual(redirected.result.showcase, { listed: false });

	clearDetectionCache();
	clearShowcaseCache();
	const negative = await checkWebsiteInput("plain.example.com", {
		fetch: createSequenceFetch([createMockResponse(["<html><body>Plain HTML</body></html>"])]),
		showcaseFetch,
		includeDnsInfrastructure: false,
	});
	assert.equal(negative.ok, true);
	assert.equal(negative.result.showcase, undefined);
	assert.equal(showcaseFetches, 1);
	clearDetectionCache();
	clearShowcaseCache();
});

void test("matches the official Starlight showcase and recognizes Azure validation DNS", async () => {
	clearStarlightShowcaseCache();
	const source = `
		<Card title="Example Docs" href="https://docs.example.com/guide/" thumbnail="docs.png" />
		<Card
			title="Project Docs"
			href="https://person.github.io/project/"
			thumbnail="project.png"
		/>
		<Card title="Unsafe" href="javascript:alert(document.domain)" thumbnail="bad.png" />
	`;
	assert.equal(parseStarlightShowcase(source).length, 2);
	const starlightFetch: typeof globalThis.fetch = () =>
		Promise.resolve(new Response(source, { status: 200 }));
	assert.deepEqual(
		await getStarlightShowcaseStatus(["https://person.github.io/project/start/"], starlightFetch),
		{
			listed: true,
			title: "Project Docs",
			url: "https://person.github.io/project/",
		},
	);
	assert.deepEqual(
		await getStarlightShowcaseStatus(["https://person.github.io/other/"], starlightFetch),
		{ listed: false },
	);
	clearStarlightShowcaseCache();

	clearDnsInfrastructureCache();
	const dnsFetch: typeof globalThis.fetch = (input) => {
		const name = new URL(input instanceof Request ? input.url : input.toString()).searchParams.get(
			"name",
		);
		return Promise.resolve(
			Response.json({
				Status: name === "asuid.example.com" ? 0 : 3,
				...(name === "asuid.example.com" && {
					Answer: [{ type: 16, data: '"verification-token"' }],
				}),
			}),
		);
	};
	assert.deepEqual(await detectDnsInfrastructure("https://example.com/", dnsFetch), [
		{
			name: "Azure App Service",
			layer: "hosting",
			evidence: "asuid TXT record",
			confidence: "likely",
		},
	]);

	clearDnsInfrastructureCache();
	let coalescedFetches = 0;
	const negativeDnsFetch: typeof globalThis.fetch = () => {
		coalescedFetches++;
		return Promise.resolve(Response.json({ Status: 3 }));
	};
	await Promise.all([
		detectDnsInfrastructure("https://coalesced.example.com/", negativeDnsFetch),
		detectDnsInfrastructure("https://coalesced.example.com/", negativeDnsFetch),
	]);
	assert.equal(coalescedFetches, 2);
	await detectDnsInfrastructure("https://coalesced.example.com/", negativeDnsFetch);
	assert.equal(coalescedFetches, 2);

	for (let index = 0; index < 256; index++) {
		await detectDnsInfrastructure(`https://cache-${String(index)}.example.com/`, negativeDnsFetch);
	}
	const fetchesBeforeEvictedLookup = coalescedFetches;
	await detectDnsInfrastructure("https://coalesced.example.com/", negativeDnsFetch);
	assert.equal(coalescedFetches, fetchesBeforeEvictedLookup + 2);
	clearDnsInfrastructureCache();
});

void test("surfaces defensible infrastructure evidence only for Astro results", async () => {
	for (const provider of INFRASTRUCTURE_PROVIDER_NAMES) {
		assert.ok(providerIconIds[provider], `Missing icon for ${provider}`);
	}

	assert.deepEqual(
		detectInfrastructure(
			new Headers({
				"cf-ray": "abc-DEN",
				"x-nf-request-id": "request-id",
			}),
		),
		[
			{
				name: "Cloudflare",
				layer: "edge",
				evidence: "cf-ray response header",
				confidence: "likely",
			},
			{
				name: "Netlify",
				layer: "hosting",
				evidence: "x-nf-request-id response header",
				confidence: "likely",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({ server: "AmazonS3" }),
			"http://example.s3-website-us-west-2.amazonaws.com/",
		),
		[{ name: "AWS S3", layer: "hosting", evidence: "S3 endpoint hostname" }],
	);
	assert.deepEqual(
		detectInfrastructure(new Headers({ server: "AmazonS3" }), "https://static.example.com/"),
		[
			{
				name: "AWS S3",
				layer: "hosting",
				evidence: "server response header",
				confidence: "likely",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({ "x-goog-generation": "1360044097835000" }),
			"https://example.storage.googleapis.com/index.html",
		),
		[
			{
				name: "Google Cloud Storage",
				layer: "hosting",
				evidence: "storage.googleapis.com hostname",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({ "x-goog-generation": "1360044097835000" }),
			"https://static.example.com/",
		),
		[
			{
				name: "Google Cloud Storage",
				layer: "hosting",
				evidence: "x-goog-generation response header",
				confidence: "likely",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({
				server: "Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0",
				"x-ms-request-id": "request-id",
			}),
			"https://example.z22.web.core.windows.net/",
		),
		[
			{
				name: "Azure Blob Storage",
				layer: "hosting",
				evidence: "web.core.windows.net hostname",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({ server: "Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0" }),
			"https://static.example.com/",
		),
		[
			{
				name: "Azure Blob Storage",
				layer: "hosting",
				evidence: "server response header",
				confidence: "likely",
			},
		],
	);
	assert.deepEqual(detectInfrastructure(new Headers(), "https://example.2.azurestaticapps.net/"), [
		{
			name: "Azure Static Web Apps",
			layer: "hosting",
			evidence: "azurestaticapps.net hostname",
		},
	]);
	assert.deepEqual(
		detectInfrastructure(new Headers(), "https://example.z32.web.storage.azure.net/"),
		[
			{
				name: "Azure Blob Storage",
				layer: "hosting",
				evidence: "web.storage.azure.net hostname",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({ server: "Google Frontend" }),
			"https://docs.example.run.app/",
		),
		[
			{
				name: "Google Cloud",
				layer: "edge",
				evidence: "server response header",
				confidence: "likely",
			},
			{ name: "Google Cloud", layer: "hosting", evidence: "run.app hostname" },
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({
				"cache-control": "public, max-age=0, must-revalidate",
				"cf-cache-status": "HIT",
				"cf-ray": "abc-DEN",
				"content-type": "text/html; charset=utf-8",
				etag: '"asset-hash"',
			}),
		),
		[
			{
				name: "Cloudflare",
				layer: "edge",
				evidence: "cf-ray response header",
				confidence: "likely",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({
				"cache-control": "public, max-age=0, must-revalidate",
				"cf-cache-status": "HIT",
				"cf-ray": "abc-DEN",
				"content-type": "text/html; charset=utf-8",
				etag: '"asset-hash"',
				"x-nf-request-id": "request-id",
			}),
		),
		[
			{
				name: "Cloudflare",
				layer: "edge",
				evidence: "cf-ray response header",
				confidence: "likely",
			},
			{
				name: "Netlify",
				layer: "hosting",
				evidence: "x-nf-request-id response header",
				confidence: "likely",
			},
		],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({
				"x-nf-request-id": "netlify",
				"x-vercel-id": "vercel",
			}),
		),
		[],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({ "x-nf-request-id": "spoofed" }),
			"https://example.vercel.app/",
		),
		[{ name: "Vercel", layer: "hosting", evidence: "vercel.app hostname" }],
	);
	assert.deepEqual(
		detectInfrastructure(
			new Headers({ "cf-ray": "abc-DEN" }),
			"https://felicity.pages.dev/",
		),
		[
			{ name: "Cloudflare", layer: "edge", evidence: "cf-ray response header" },
			{
				name: "Cloudflare Pages",
				layer: "hosting",
				evidence: "pages.dev hostname",
			},
		],
	);

	const astroResult = await isAstroWebsite(targetUrl, {
		fetch: createSequenceFetch([
			createMockResponse(['<meta name="generator" content="Astro 5"></head>'], {
				headers: { "x-vercel-id": "iad1::request-id" },
			}),
		]),
	});
	assert.deepEqual(astroResult.infrastructure, [
		{
			name: "Vercel",
			layer: "hosting",
			evidence: "x-vercel-id response header",
			confidence: "likely",
		},
	]);

	clearDetectionCache();
	clearDnsInfrastructureCache();
	const orderedResult = await checkWebsiteInput(targetUrl, {
		fetch: createSequenceFetch([
			createMockResponse(['<meta name="generator" content="Astro 5"></head>'], {
				headers: { "x-vercel-id": "iad1::request-id" },
			}),
		]),
		includeShowcase: false,
		dnsFetch: (input) => {
			const name = new URL(
				input instanceof Request ? input.url : input.toString(),
			).searchParams.get("name");
			return Promise.resolve(
				Response.json({
					...(name === "_dnsauth.example.com" && {
						Answer: [{ type: 16, data: '"front-door-token"' }],
					}),
				}),
			);
		},
	});
	assert.equal(orderedResult.ok, true);
	assert.deepEqual(
		orderedResult.result.infrastructure?.map((provider) => provider.layer),
		["edge", "hosting"],
	);
	clearDetectionCache();
	clearDnsInfrastructureCache();

	const plainResult = await isAstroWebsite(targetUrl, {
		fetch: createSequenceFetch([
			createMockResponse(["<html><body>Plain HTML</body></html>"], {
				headers: { "x-vercel-id": "iad1::request-id" },
			}),
		]),
	});
	assert.equal(plainResult.infrastructure, undefined);
});

void test("enforces upstream byte limits while streaming", async () => {
	const response = createMockResponse(["€€", "€€"]);
	await assert.rejects(
		readResponseTextWithLimit(response, 10, "too large"),
		/too large/,
	);
});

void test("serves showcase data when edge cache operations fail", async () => {
	const previousFetch = globalThis.fetch;
	const previousCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
	let backgroundWrite: Promise<unknown> | undefined;
	clearShowcaseCache();
	globalThis.fetch = () =>
		Promise.resolve(
			Response.json([{ title: "Example", url: "https://example.com/", slug: "example" }]),
		);
	Object.defineProperty(globalThis, "caches", {
		configurable: true,
		value: {
			default: {
				match: () => Promise.reject(new Error("cache unavailable")),
				put: () => Promise.reject(new Error("cache write failed")),
			},
		},
	});

	try {
		const response = await getShowcaseJson({
			request: new Request("https://isastro.example/showcase.json"),
			locals: {
				runtime: {
					ctx: {
						waitUntil(promise: Promise<unknown>) {
							backgroundWrite = promise;
						},
					},
				},
			},
		} as never);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), [
			{ title: "Example", url: "https://example.com/", slug: "example" },
		]);
		await backgroundWrite;
	} finally {
		globalThis.fetch = previousFetch;
		if (previousCaches) Object.defineProperty(globalThis, "caches", previousCaches);
		else Reflect.deleteProperty(globalThis, "caches");
		clearShowcaseCache();
	}
});

void test("does not accept unrelated generator attributes", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			'<!doctype html><html><head><meta data-kind="generator" content="Astro 5"></head><body>Plain HTML</body></html>',
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, false);
});

void test("ignores generator metadata outside the document head", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			'<!doctype html><html><head><title>Plain site</title></head><body><meta name="generator" content="Astro 5"></body></html>',
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, false);
});

void test("ignores Astro-looking examples, comments, and escaped markup", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			'<!doctype html><html><head><script>const example = `<meta name="generator" content="Astro 5"><div data-astro-cid-demo>`;</script><!-- <astro-island></astro-island> --></head>',
			"<body><pre><div data-astro-cid-example></div></pre>&lt;div data-astro-cid-escaped&gt;</body></html>",
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, false);
});

void test("follows each HTTP redirect once and checks the final response", async () => {
	const calls: FetchCall[] = [];
	let redirectBodyCancelled = false;
	const redirectBody = new ReadableStream<Uint8Array>({
		cancel() {
			redirectBodyCancelled = true;
		},
	});
	const fetch = createSequenceFetch(
		[
			new Response(redirectBody, { status: 302, headers: { Location: "/destination" } }),
			createMockResponse([
				'<!doctype html><html><head><meta name="generator" content="Astro 5"></head></html>',
			]),
		],
		calls,
	);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, true);
	assert.deepEqual(
		calls.map(({ url }) => url),
		[targetUrl, "https://example.com/destination"],
	);
	assert.equal(redirectBodyCancelled, true);
});

void test("detects a meta refresh split across response chunks", async () => {
	const calls: FetchCall[] = [];
	const fetch = createSequenceFetch(
		[
			createMockResponse([
				'<!doctype html><html><head><meta http-equiv="ref',
				'RESH" content="0; url=/next"></head></html>',
			]),
			createMockResponse([
				'<!doctype html><html><head><meta name="generator" content="Astro"></head></html>',
			]),
		],
		calls,
	);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, true);
	assert.equal(calls[1]?.url, "https://example.com/next");
});

void test("rejects private initial and redirect targets", async () => {
	let fetchCount = 0;
	const unusedFetch: typeof globalThis.fetch = () => {
		fetchCount++;
		return Promise.resolve(createMockResponse(["<html></html>"]));
	};
	await assert.rejects(
		isAstroWebsite("http://127.0.0.1", { fetch: unusedFetch }),
		(error: unknown) => error instanceof CustomError && /disallowed/i.test(error.message),
	);
	assert.equal(fetchCount, 0);

	const redirectFetch = createSequenceFetch([
		new Response(null, { status: 302, headers: { Location: "http://10.0.0.1/" } }),
	]);
	await assert.rejects(
		isAstroWebsite(targetUrl, { fetch: redirectFetch }),
		(error: unknown) => error instanceof CustomError && /disallowed/i.test(error.message),
	);
});

void test("rejects final HTTP errors and non-HTML responses", async () => {
	await assert.rejects(
		isAstroWebsite(targetUrl, {
			fetch: createSequenceFetch([createMockResponse(["not found"], { status: 404 })]),
		}),
		(error: unknown) => error instanceof CustomError && error.message.includes("status: 404"),
	);
	await assert.rejects(
		isAstroWebsite(targetUrl, {
			fetch: createSequenceFetch([
				createMockResponse(["{}"], { headers: { "Content-Type": "application/json" } }),
			]),
		}),
		(error: unknown) => error instanceof CustomError && /content type/i.test(error.message),
	);
	await assert.rejects(
		isAstroWebsite(targetUrl, {
			fetch: createSequenceFetch([createMockResponse([""])]),
		}),
		(error: unknown) => error instanceof CustomError && /empty response body/i.test(error.message),
	);
});

void test("reports bot challenges served with an error status as blocked", async () => {
	await assert.rejects(
		isAstroWebsite(targetUrl, {
			fetch: createSequenceFetch([
				createMockResponse(["<title>Just a moment...</title>"], {
					status: 403,
					headers: { "cf-mitigated": "challenge", server: "cloudflare" },
				}),
			]),
		}),
		(error: unknown) => error instanceof CustomError && error.message === "Bot challenge detected",
	);
	await assert.rejects(
		isAstroWebsite(targetUrl, {
			fetch: createSequenceFetch([
				createMockResponse(['<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>'], {
					status: 503,
				}),
			]),
		}),
		(error: unknown) => error instanceof CustomError && error.message === "Bot challenge detected",
	);
});

void test("enforces the response byte limit", async () => {
	await assert.rejects(
		isAstroWebsite(targetUrl, {
			fetch: createSequenceFetch([createMockResponse(["<html>", "x".repeat(128)])]),
			maxBytes: 64,
		}),
		(error: unknown) => error instanceof CustomError && error.message.includes("byte limit"),
	);
});

void test("contains response-stream cancellation failures after early detection", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					'<!doctype html><html><head><meta name="generator" content="Astro 5"></head><body>',
				),
			);
		},
		cancel() {
			throw new Error("cancel failed");
		},
	});
	const result = await isAstroWebsite(targetUrl, {
		fetch: createSequenceFetch([new Response(body, { headers: { "Content-Type": "text/html" } })]),
	});
	assert.equal(result.isAstro, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
});

void test("keeps the timeout active while the response body is stalled", async () => {
	const stalledBody = new ReadableStream<Uint8Array>({
		start() {
			// Intentionally never enqueue or close.
		},
	});
	await assert.rejects(
		isAstroWebsite(targetUrl, {
			fetch: createSequenceFetch([
				new Response(stalledBody, { headers: { "Content-Type": "text/html" } }),
			]),
			timeoutMs: 25,
		}),
		(error: unknown) => error instanceof CustomError && error.message === "Request timed out",
	);
});

void test("coalesces concurrent cached checks and reuses the result", async () => {
	clearDetectionCache();
	let fetchCount = 0;
	const fetch: typeof globalThis.fetch = async () => {
		fetchCount++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return createMockResponse([
			'<!doctype html><html><head><meta name="generator" content="Astro 5"></head></html>',
		]);
	};
	const options = { fetch, cacheTtlMs: 1_000 };
	const [first, second] = await Promise.all([
		getCachedAstroDetection(`${targetUrl}#first`, options),
		getCachedAstroDetection(`${targetUrl}#second`, options),
	]);
	const third = await getCachedAstroDetection(`${targetUrl}#third`, options);
	assert.equal(fetchCount, 1);
	assert.strictEqual(first, second);
	assert.strictEqual(second, third);
	clearDetectionCache();
});

void test("normalizes ordinary input without decoding it twice", () => {
	assert.deepEqual(normalizeWebsiteUrl(" example.com/path%252Fvalue "), {
		ok: true,
		url: "https://example.com/path%252Fvalue",
	});
	assert.equal(normalizeWebsiteUrl("").ok, false);
	assert.equal(normalizeWebsiteUrl("%").ok, false);
	assert.deepEqual(normalizeWebsiteUrl("example.com/path#section"), {
		ok: true,
		url: "https://example.com/path",
	});
});

void test("allows public HTTP targets and rejects unsafe URL forms", () => {
	assert.equal(isValidUrl("https://astro.build/"), true);
	assert.equal(isValidUrl("http://example.com:8080/path"), true);
	for (const value of [
		"ftp://example.com/file",
		"http://localhost/",
		"http://192.168.1.1/",
		"http://[::1]/",
		"https://user:password@example.com/",
	]) {
		assert.equal(isValidUrl(value), false, value);
	}
});
