import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWebsiteInput, PROVIDER_NAMES, type Check, type Network } from "@lib/check";
import type { Connect } from "@lib/check/socket-head";
import { providerIconIds } from "@lib/provider-icons";

type Page = {
	chunks?: string[];
	status?: number;
	headers?: Record<string, string>;
	/** The host's DNS answer. Defaults to a non-Cloudflare address. */
	address?: string;
	/** On Cloudflare's network outside its published ranges (e.g. Render): sockets are refused. */
	refusesSockets?: boolean;
	/** What a raw socket gets instead of the page, e.g. a firewall blocking Cloudflare's socket egress. */
	socketResponse?: { status: number; headers: Record<string, string> };
};

const DEFAULT_ADDRESS = "93.184.215.14";

/**
 * A fake internet: `pages` by URL, plus fixed DNS and showcase services. Like
 * fetch() inside Cloudflare, page responses get `server: cloudflare` and a
 * `cf-ray`, unless the site really is on Cloudflare. Sockets see the real head.
 */
function fakeNetwork(pages: Record<string, Page>, requested: string[] = []): Network {
	const fetch: typeof globalThis.fetch = (input) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			const name = url.searchParams.get("name");
			const host = Object.entries(pages).find(([page]) => new URL(page).hostname === name);
			const Answer =
				host && url.searchParams.get("type") === "A"
					? [{ type: 1, data: host[1].address ?? DEFAULT_ADDRESS }]
					: [];
			return Promise.resolve(Response.json({ Answer }));
		}
		if (url.hostname === "astro.build") {
			return Promise.resolve(
				Response.json([{ title: "Listed", url: "https://listed.example/", slug: "listed" }]),
			);
		}
		if (url.hostname === "raw.githubusercontent.com") {
			return Promise.resolve(
				new Response('<Card title="Docs" href="https://docs.example/" thumbnail="x.png" />'),
			);
		}
		requested.push(url.toString());
		const page = pages[url.toString()];
		if (!page) return Promise.reject(new TypeError(`fetch failed: ${url.toString()}`));
		const chunks = [...(page.chunks ?? [])];
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk === undefined) controller.close();
				else controller.enqueue(new TextEncoder().encode(chunk));
			},
		});
		const headers = new Headers({ "content-type": "text/html", ...page.headers });
		headers.set("server", "cloudflare");
		if (!headers.has("cf-ray")) headers.set("cf-ray", "injected-LHR");
		return Promise.resolve(new Response(body, { status: page.status ?? 200, headers }));
	};

	const connect: Connect = ({ hostname }, { secureTransport }) => {
		const refused = Object.entries(pages).some(
			([url, page]) => new URL(url).hostname === hostname && page.refusesSockets,
		);
		let receiveRequest: (request: string) => void = () => undefined;
		const request = new Promise<string>((resolve) => (receiveRequest = resolve));
		return {
			writable: new WritableStream({
				write(bytes) {
					receiveRequest(new TextDecoder().decode(bytes));
				},
			}),
			readable: new ReadableStream({
				async start(controller) {
					const path = (await request).split(" ")[1] ?? "/";
					const page = pages[`${secureTransport === "on" ? "https" : "http"}://${hostname}${path}`];
					if (!page) {
						controller.error(new Error("connection refused"));
						return;
					}
					const { status, headers } = page.socketResponse ?? {
						status: page.status ?? 200,
						headers: { "content-type": "text/html", ...page.headers },
					};
					const head = `HTTP/1.1 ${String(status)} X\r\n${Object.entries(headers)
						.map(([name, value]) => `${name}: ${value}\r\n`)
						.join("")}\r\n`;
					// Split mid-line, as a real network might.
					controller.enqueue(new TextEncoder().encode(head.slice(0, 20)));
					controller.enqueue(new TextEncoder().encode(`${head.slice(20)}<html>`));
					controller.close();
				},
			}),
			// Workers reject sockets to Cloudflare's network before connecting.
			opened: refused
				? Promise.reject(new Error("proxy request failed, cannot connect to the specified address"))
				: Promise.resolve({}),
			close: () => Promise.resolve(),
		};
	};
	return { fetch, connect };
}

async function check(
	input: string,
	pages: Record<string, Page>,
	requested?: string[],
): Promise<Check> {
	const result = await checkWebsiteInput(input, fakeNetwork(pages, requested));
	assert.ok(result.ok, "input should be valid");
	return result.check;
}

void test("reads versions from split, reordered generator tags and reports showcases and platform", async () => {
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
		evidence: ['generator meta tag "Astro v5.1"', 'generator meta tag "Starlight v0.30"'],
	});
	assert.deepEqual(result.showcase, {
		astro: { listed: true, title: "Listed", url: "https://listed.example/" },
		starlight: { listed: false },
	});
	assert.deepEqual(result.infrastructure.providers, [
		{ name: "Vercel", role: "hosting", evidence: ["x-vercel-id: iad1::abc", "server: Vercel"] },
	]);
});

void test("finds body markers in minified pages without </head>", async () => {
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
	assert.deepEqual(island.verdict, {
		status: "astro",
		starlight: false,
		evidence: ["astro-* element"],
	});

	const viewTransitions = await check("https://transitions.example", {
		"https://transitions.example/": {
			chunks: [
				"<html><head><style>[data-astro-transition-scope]{animation:none}</style></head><body></body>",
			],
		},
	});
	assert.equal(viewTransitions.verdict.status, "astro");

	// The ClientRouter's lifecycle events, used from an inline module script (as Astro emits it).
	const clientRouter = await check("https://router.example", {
		"https://router.example/": {
			chunks: [
				'<html><head></head><body><script type="module">document.addEventListener("astro:before-swap",',
				" () => {});</script></body>",
			],
		},
	});
	assert.deepEqual(clientRouter.verdict, {
		status: "astro",
		starlight: false,
		evidence: ["astro:* event listener"],
	});
});

void test("ignores Astro-looking text that isn't real markup", async () => {
	const result = await check("https://plain.example", {
		"https://plain.example/": {
			chunks: [
				'<html><head><script>const x = `<meta name="generator" content="Astro 5"><div data-astro-cid-x>`;</script>',
				"<!-- <astro-island> --></head><body><pre><div data-astro-cid-example></div></pre>",
				'&lt;div data-astro-cid-escaped&gt;<meta name="generator" content="Astro 5">',
				'<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
				// Next.js streams page text (here, a code sample from a post about Astro) in classic scripts.
				`<script>self.__next_f.push([1,"document.addEventListener('astro:page-load', f)"])</script></body></html>`,
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

	const requestedPrivate: string[] = [];
	const privateDns = await check(
		"https://rebind.example",
		{ "https://rebind.example/": { address: "10.0.0.1" } },
		requestedPrivate,
	);
	assert.deepEqual(privateDns.verdict, { status: "unreachable", reason: "network-error" });
	assert.deepEqual(requestedPrivate, []);
});

void test("reports bot walls as blocked while keeping the infrastructure they reveal", async () => {
	const cloudflare = await check("https://walled.example", {
		"https://walled.example/": {
			address: "104.16.132.229",
			status: 403,
			headers: { "cf-mitigated": "challenge", server: "cloudflare", "cf-ray": "abc-EWR" },
			chunks: ["<title>Just a moment...</title>"],
		},
	});
	assert.deepEqual(cloudflare.verdict, { status: "blocked", by: "cloudflare" });
	assert.deepEqual(cloudflare.infrastructure.providers, [
		{
			name: "Cloudflare",
			role: "cdn",
			evidence: [
				"address 104.16.132.229 on Cloudflare's network",
				"cf-ray: abc-EWR",
				"server: cloudflare",
			],
		},
	]);

	const siteground = await check("https://sg.example", {
		"https://sg.example/": {
			status: 202,
			chunks: ['<head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F">'],
		},
	});
	assert.deepEqual(siteground.verdict, { status: "blocked", by: "sgcaptcha" });

	const down = await check("https://down.example", { "https://down.example/": { status: 500 } });
	assert.deepEqual(down.verdict, { status: "unreachable", reason: "http-error", httpStatus: 500 });

	// Cloudflare wraps origin failures in a 530 whose body names the 1xxx error.
	const originError = await check("https://origin-error.example", {
		"https://origin-error.example/": {
			address: "104.16.132.229",
			status: 530,
			headers: { server: "cloudflare" },
			chunks: ["error code: 1016"],
		},
	});
	assert.deepEqual(originError.verdict, {
		status: "unreachable",
		reason: "http-error",
		httpStatus: 530,
		cloudflareError: 1016,
	});
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
		assert.equal((await checkWebsiteInput(input, fakeNetwork({}, requested))).ok, false, input);
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

void test("reports infrastructure as cited facts from provider-specific signals only", async () => {
	const githubPages = await check("https://custom-domain.example", {
		"https://custom-domain.example/": {
			headers: {
				server: "GitHub.com",
				"x-served-by": "cache-lhr-egll1980078-LHR",
				"x-github-request-id": "BA64:B7B33",
				"cache-control": "max-age=600",
				"x-powered-by": "Express",
				"set-cookie": "session=secret",
			},
			chunks: ['<meta name="generator" content="Astro">'],
		},
	});
	assert.deepEqual(githubPages.infrastructure, {
		providers: [
			{ name: "Fastly", role: "cdn", evidence: ["x-served-by: cache-lhr-egll1980078-LHR"] },
			{ name: "GitHub Pages", role: "hosting", evidence: ["server: GitHub.com"] },
		],
		headers: [
			{ name: "server", value: "GitHub.com" },
			{ name: "x-powered-by", value: "Express" },
			{ name: "cache-control", value: "max-age=600" },
			{ name: "x-served-by", value: "cache-lhr-egll1980078-LHR" },
		],
	});

	// GitHub's own sites send x-github-request-id too, so that alone isn't GitHub Pages.
	const githubDocs = await check("https://docs.github.example", {
		"https://docs.github.example/": {
			headers: { server: "github.com", "x-github-request-id": "DBF4:31EAC5" },
			chunks: ['<meta name="generator" content="Astro">'],
		},
	});
	assert.deepEqual(githubDocs.infrastructure.providers, []);

	// Render serves through Cloudflare from its own addresses: outside Cloudflare's
	// published ranges, but Workers still refuse sockets to them.
	const render = await check("https://render-site.example", {
		"https://render-site.example/": {
			refusesSockets: true,
			headers: { "rndr-id": "4b1" },
			chunks: ['<meta name="generator" content="Astro">'],
		},
	});
	assert.equal(render.verdict.status, "astro");
	const [cdn, hosting] = render.infrastructure.providers;
	assert.deepEqual(cdn?.evidence[0], "address 93.184.215.14 on Cloudflare's network");
	assert.deepEqual(hosting, { name: "Render", role: "hosting", evidence: ["rndr-id: 4b1"] });

	// The socket asks for an uncompressed page, so its content-length can exceed the
	// size cap; only fetch()'s headers decide how the page is read.
	const uncompressed = await check("https://big-uncompressed.example", {
		"https://big-uncompressed.example/": {
			socketResponse: { status: 200, headers: { server: "nginx", "content-length": "5000000" } },
			chunks: ['<meta name="generator" content="Astro">'],
		},
	});
	assert.equal(uncompressed.verdict.status, "astro");
	assert.deepEqual(uncompressed.infrastructure.headers, [{ name: "server", value: "nginx" }]);

	// A firewall answering Cloudflare's socket egress differently: keep fetch()'s
	// headers, minus the ones fetch() inside Cloudflare fakes.
	const firewalled = await check("https://firewalled.example", {
		"https://firewalled.example/": {
			headers: { "x-nf-request-id": "01ABC" },
			socketResponse: { status: 403, headers: { server: "openresty" } },
			chunks: ['<meta name="generator" content="Astro">'],
		},
	});
	assert.equal(firewalled.verdict.status, "astro");
	assert.deepEqual(firewalled.infrastructure, {
		providers: [{ name: "Netlify", role: "hosting", evidence: ["x-nf-request-id: 01ABC"] }],
		headers: [{ name: "x-nf-request-id", value: "01ABC" }],
	});

	for (const name of PROVIDER_NAMES) assert.ok(providerIconIds[name], `Missing icon for ${name}`);
});
