# isAstro

https://isastro.pages.dev

Attempts to see if a website is made with Astro

Looks for:

1. Generator tags, including Astro and Starlight version detection
2. use of Astro's scoped css markers
3. use of `data-astro-` attributes or `astro-` class
4. use of `_astro/` directory

Attempts to be fast and not download more than needed, but will try to wait for the entire head to get a good faith attempt to find the generator tag because it's nice to see the version

The main logic is in [lib/modules/server](./src/lib/modules/server/index.ts)

There are [some tests](./src/lib/test/index.ts) run with `pnpm test`

## Cloudflare Pages compatibility

This project intentionally pins Astro 5.18.2 and `@astrojs/cloudflare` 12.6.13. These
are the final versions that support server-side rendering on Cloudflare Pages. Adapter
v13 and later target Cloudflare Workers instead, so upgrading Astro past v5 also
requires migrating the deployment from Pages to Workers.

## JSON API

Send a `GET` request to `/api?url=astro.build` with a website URL or hostname. The route
allows cross-origin `GET` requests and responds to CORS `OPTIONS` preflight requests.

Successful checks return:

```js
{
	url: string;
	isAstro: boolean;
	isStarlight: boolean;
	mechanism: string;
	lastFetchedUrl: string;
	astroVersion?: string;
	starlightVersion?: string;
}
```

The OpenAPI 3.1 description is served at `/openapi.json`. Regenerate
`public/openapi.json` after changing the API contract or package version:

```sh
pnpm generate-openapi
```
