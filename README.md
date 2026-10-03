# isAstro

https://isastro.pages.dev

Attempts to see if a website is made with Astro

Looks for:

1. Generator tags, including Astro and Starlight version detection
2. use of Astro's scoped css markers
3. use of `data-astro-` attributes or `astro-` class
4. use of `_astro/` directory

Attempts to be fast and not download more than needed, but will try to wait for the entire head to get a good faith attempt to find the generator tag because it's nice to see the version

The main logic is in [lib/check](./src/lib/check/index.ts): a small `fetch → classify → scan` state machine
([detect.ts](./src/lib/check/detect.ts)) over a single-pass streaming HTML scanner ([html-scanner.ts](./src/lib/check/html-scanner.ts)).

There are [some tests](./src/lib/test/index.ts) run with `pnpm test`

## Cloudflare Pages compatibility

This project intentionally pins Astro 5.18.2 and `@astrojs/cloudflare` 12.6.13. These
are the final versions that support server-side rendering on Cloudflare Pages. Adapter
v13 and later target Cloudflare Workers instead, so upgrading Astro past v5 also
requires migrating the deployment from Pages to Workers.

## JSON API

Send a `GET` request to `/api?url=astro.build` with a website URL or hostname. The route
allows cross-origin `GET` requests and responds to CORS `OPTIONS` preflight requests.

Any check that ran returns `200`, including sites that blocked us or were down. Only invalid
input returns `400`.

```ts
{
	url: string;
	finalUrl: string; // after redirects
	verdict:
		| { status: "astro"; starlight: boolean; astroVersion?: string; starlightVersion?: string; evidence: string[]; starlightEvidence?: string[] }
		| { status: "not-astro" }
		| { status: "blocked"; by: "cloudflare" | "vercel" | "sgcaptcha" | "unknown" }
		| { status: "unreachable"; reason: "timeout" | "network-error" | "http-error" | "not-html" | "empty-body" | "too-large" | "too-many-redirects" | "disallowed-redirect"; httpStatus?: number; cloudflareError?: number };
	infrastructure: {
		// Named only from signals a single provider emits; CDNs first. A CDN usually hides the host.
		providers: { name: string; role: "cdn" | "hosting"; evidence: string[] }[]; // e.g. "cf-ray: 8f1a…-EWR"
		headers: { name: string; value: string }[]; // raw server/cache headers, plus every cited header
	};
	showcase?: { astro?: ShowcaseStatus; starlight?: ShowcaseStatus }; // Astro sites only
}

type ShowcaseStatus = { listed: false } | { listed: true; title: string; url: string };
```

Positive checks also compare the final site with the official Astro showcase. The showcase
dataset is cached for one day and is available to the minimal client-side search at `/showcase`.
Starlight detections are also compared with Starlight's official showcase source. Non-root
listings are matched by path so unrelated projects on a shared hostname are not conflated.

The OpenAPI 3.1 description is served at `/openapi.json`. Regenerate
`public/openapi.json` after changing the API contract or package version:

```sh
pnpm generate-openapi
```
