import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clearDetectionCache,
	CustomError,
	getCachedAstroDetection,
	isAstroWebsite,
	isValidUrl,
} from "@modules/server";
import { normalizeWebsiteUrl } from "@modules/server/request";
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

void test("does not accept unrelated generator attributes", async () => {
	const fetch = createSequenceFetch([
		createMockResponse([
			'<!doctype html><html><head><meta data-kind="generator" content="Astro 5"></head><body>Plain HTML</body></html>',
		]),
	]);
	const result = await isAstroWebsite(targetUrl, { fetch });
	assert.equal(result.isAstro, false);
});

void test("follows each HTTP redirect once and checks the final response", async () => {
	const calls: FetchCall[] = [];
	const fetch = createSequenceFetch(
		[
			new Response(null, { status: 302, headers: { Location: "/destination" } }),
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
		getCachedAstroDetection(targetUrl, options),
		getCachedAstroDetection(targetUrl, options),
	]);
	const third = await getCachedAstroDetection(targetUrl, options);
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
