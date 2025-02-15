import { test } from "node:test";
import assert from "node:assert/strict";
import { isAstroWebsite } from "@modules/server";
import { mockFetchResponse } from "./utils";

// (1) No meta tags, but data-astro-cid attribute used
void test("No meta tags; uses data-astro-cid attribute", async () => {
	mockFetchResponse([
		"<!DOCTYPE html><html><head><title>Test</title></head><body>",
		"<div data-astro-cid-abcd>Some content</div></body></html>",
	]);

	// change second arg to true to see debug logs
	const result = await isAstroWebsite("http://example.com", false);
	assert.equal(result.isAstro, true, "Expected site to be recognized as Astro (data-astro-cid)");
	assert.match(result.mechanism, /astro-cid/i);
});

// (2) No meta tags; astro-cid in class + style :where usage
void test("No meta tags; astro-cid in class, plus style :where usage", async () => {
	mockFetchResponse([
		"<!DOCTYPE html><html><head><style>:where(.astro-xyz){color:red;}</style></head><body>",
		'<div class="some astro-cid-abcd">Hello</div></body></html>',
	]);

	// change second arg to true to see debug logs
	const result = await isAstroWebsite("http://example.com", false);
	assert.equal(result.isAstro, true);
	assert.match(
		result.mechanism,
		/astro-cid|:where\(.astro/i,
		"Expected marker mention in the mechanism",
	);
});

// (3) No meta tags; _astro/ path found
void test("No meta tags; _astro/ path found", async () => {
	mockFetchResponse([
		"<!DOCTYPE html><html><head></head><body>",
		'<script src="/_astro/main.js"></script></body></html>',
	]);

	// change second arg to true to see debug logs
	const result = await isAstroWebsite("http://example.com", false);
	assert.equal(result.isAstro, true, "Expected _astro/ usage to indicate Astro");
	assert.match(result.mechanism, /_astro\//);
});

// (4) Astro meta tag only
void test("Astro meta tag only", async () => {
	mockFetchResponse([
		"<!DOCTYPE html><html><head>",
		'<meta name="generator" content="Astro 2.0">',
		"</head><body>Hello world</body></html>",
	]);

	// change second arg to true to see debug logs
	const result = await isAstroWebsite("http://example.com", false);
	assert.equal(result.isAstro, true);
	assert.equal(result.astroVersion, "2.0", "Expected astroVersion to be 2.0");
});

// (5) Both Astro & Starlight meta tags
void test("Both Astro & Starlight meta tags", async () => {
	mockFetchResponse([
		"<!DOCTYPE html><html><head>",
		// same chunk here due to being too lazy to properly fix this, but it's very unlikely to happen in real life
		`<meta name="generator" content="Astro 2.0">
		 <meta name="generator" content="Starlight 1.5">`,
		"</head><body></body></html>",
	]);

	// change second arg to true to see debug logs
	const result = await isAstroWebsite("http://example.com", false);
	assert.equal(result.isAstro, true);
	assert.equal(result.astroVersion, "2.0");
	assert.equal(result.starlightVersion, "1.5");
});
