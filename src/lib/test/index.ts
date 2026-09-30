import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWebsiteInput, PROVIDER_NAMES, type Check } from "@lib/check";
import { providerIconIds } from "@lib/provider-icons";

type Page = { chunks?: string[]; status?: number; headers?: Record<string, string> };

/** A fake internet: `pages` by URL, plus fixed showcase and DNS services. */
function fakeInternet(
	pages: Record<string, Page>,
	requested: string[] = [],
): typeof globalThis.fetch {
	return (input) => {
		const url = input instanceof Request ? input.url : input.toString();
		requested.push(url);
		if (url.startsWith("https://astro.build/api/showcase.json")) {
			return Promise.resolve(
				Response.json([{ title: "Listed", url: "https://listed.example/", slug: "listed" }]),
			);
		}
		if (url.startsWith("https://raw.githubusercontent.com/")) {
			return Promise.resolve(
				new Response('<Card title="Docs" href="https://docs.example/" thumbnail="x.png" />'),
			);
		}
		if (url.startsWith("https://cloudflare-dns.com/"))
			return Promise.resolve(Response.json({ Status: 3 }));
		const page = pages[url];
		if (!page) return Promise.reject(new TypeError(`fetch failed: ${url}`));
		const chunks = [...(page.chunks ?? [])];
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk === undefined) controller.close();
				else controller.enqueue(new TextEncoder().encode(chunk));
			},
		});
		const headers = { "content-type": "text/html", ...page.headers };
		return Promise.resolve(new Response(body, { status: page.status ?? 200, headers }));
	};
}

async function check(
	input: string,
	pages: Record<string, Page>,
	requested?: string[],
): Promise<Check> {
	const result = await checkWebsiteInput(input, fakeInternet(pages, requested));
	assert.ok(result.ok, "input should be valid");
	return result.check;
}

void test("reads versions from split, reordered generator tags and reports showcases and host", async () => {
	const result = await check("listed.example", {
		"https://listed.example/": {
			headers: { server: "Vercel", "x-vercel-id": "iad1::abc" },
			chunks: [
				'<!doctype html><html><head><link rel="stylesheet" href="/_astro/index.css"><meta content="Astro v5.1" na',
				'me="generator"><meta name="generator" content="Starlight v0.30"></head><body></body></html>',
			],
		},
	});
	assert.deepEqual(result.verdict, {
		status: "astro",
		starlight: true,
		astroVersion: "v5.1",
		starlightVersion: "v0.30",
		evidence: [
			'generator meta tag "Astro v5.1"',
			'generator meta tag "Starlight v0.30"',
			"_astro/ asset",
		],
	});
	assert.deepEqual(result.showcase, {
		astro: { listed: true, title: "Listed", url: "https://listed.example/" },
		starlight: { listed: false },
	});
	assert.deepEqual(result.infrastructure, {
		edge: {
			status: "identified",
			providers: [{ name: "Vercel", confidence: "confirmed", evidence: ["server header"] }],
		},
		host: {
			status: "identified",
			providers: [{ name: "Vercel", confidence: "confirmed", evidence: ["x-vercel-id header"] }],
		},
	});
});

void test("finds body markers in minified pages without </head>, and hides the host behind a CDN", async () => {
	const result = await check("https://minified.example", {
		"https://minified.example/": {
			headers: { "cf-ray": "abc-DEN" },
			chunks: ["<html><title>x</title><div class=astro-j7pv25f6>hi</div>"],
		},
	});
	assert.deepEqual(result.verdict, {
		status: "astro",
		starlight: false,
		evidence: ["scoped astro-* class"],
	});
	assert.deepEqual(result.infrastructure.host, { status: "hidden" });

	// Islands inline their props, so a single tag can span many network chunks.
	const props = `props="${"x".repeat(40_000)}"`;
	const island = await check("https://island.example", {
		"https://island.example/": {
			chunks: [
				"<body><astro-island uid=1 ",
				props.slice(0, 20_000),
				props.slice(20_000),
				"></astro-island>",
			],
		},
	});
	assert.equal(island.verdict.status, "astro");

	const viewTransitions = await check("https://transitions.example", {
		"https://transitions.example/": {
			chunks: [
				"<html><head><style>[data-astro-transition-scope]{animation:none}</style></head><body></body>",
			],
		},
	});
	assert.equal(viewTransitions.verdict.status, "astro");
});

void test("ignores Astro-looking text that isn't real markup", async () => {
	const result = await check("https://plain.example", {
		"https://plain.example/": {
			chunks: [
				'<html><head><script>const x = `<meta name="generator" content="Astro 5"><div data-astro-cid-x>`;</script>',
				"<!-- <astro-island> --></head><body><pre><div data-astro-cid-example></div></pre>",
				'&lt;div data-astro-cid-escaped&gt;<meta name="generator" content="Astro 5">',
				'<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>',
			],
		},
	});
	assert.deepEqual(result.verdict, { status: "not-astro" });
	assert.equal(result.showcase, undefined);
});

void test("follows redirects and meta refreshes, but never to private addresses", async () => {
	const requested: string[] = [];
	const followed = await check(
		"https://start.example",
		{
			"https://start.example/": { status: 301, headers: { location: "/next" } },
			"https://start.example/next": {
				chunks: ['<head><meta http-equiv="refresh" content="0; url=/final">'],
			},
			"https://start.example/final": { chunks: ["<body><astro-island></astro-island>"] },
		},
		requested,
	);
	assert.equal(followed.finalUrl, "https://start.example/final");
	assert.equal(followed.verdict.status, "astro");

	const privateRedirect = await check("https://ssrf.example", {
		"https://ssrf.example/": { status: 302, headers: { location: "http://169.254.169.254/" } },
	});
	assert.deepEqual(privateRedirect.verdict, {
		status: "unreachable",
		reason: "disallowed-redirect",
	});
});

void test("reports bot walls as blocked while keeping the infrastructure they reveal", async () => {
	const cloudflare = await check("https://walled.example", {
		"https://walled.example/": {
			status: 403,
			headers: { "cf-mitigated": "challenge", server: "cloudflare", "cf-ray": "abc-EWR" },
			chunks: ["<title>Just a moment...</title>"],
		},
	});
	assert.deepEqual(cloudflare.verdict, { status: "blocked", by: "cloudflare" });
	assert.deepEqual(cloudflare.infrastructure.edge, {
		status: "identified",
		providers: [
			{ name: "Cloudflare", confidence: "confirmed", evidence: ["cf-ray header", "server header"] },
		],
	});

	const siteground = await check("https://sg.example", {
		"https://sg.example/": {
			status: 202,
			chunks: ['<head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F">'],
		},
	});
	assert.deepEqual(siteground.verdict, { status: "blocked", by: "sgcaptcha" });

	const down = await check("https://down.example", { "https://down.example/": { status: 500 } });
	assert.deepEqual(down.verdict, { status: "unreachable", reason: "http-error", httpStatus: 500 });
});

void test("rejects bad input without fetching, and coalesces concurrent checks", async () => {
	const requested: string[] = [];
	for (const input of [
		"",
		"localhost",
		"http://192.168.1.1",
		"ftp://example.com",
		"https://user:pw@example.com",
	]) {
		assert.equal((await checkWebsiteInput(input, fakeInternet({}, requested))).ok, false, input);
	}
	assert.deepEqual(requested, []);

	const pages = {
		"https://popular.example/": { chunks: ['<meta name="generator" content="Astro">'] },
	};
	await Promise.all([
		check("popular.example", pages, requested),
		check("popular.example#x", pages, requested),
	]);
	assert.equal(requested.filter((url) => url === "https://popular.example/").length, 1);
});

void test("every infrastructure provider has an icon", () => {
	for (const name of PROVIDER_NAMES) assert.ok(providerIconIds[name], `Missing icon for ${name}`);
});
