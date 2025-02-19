# isAstro

https://isastro.pages.dev

Attempts to see if a website is made with Astro

Looks for:

1. Generator tag
2. use of Astro's scoped css markers
3. use of `data-astro-` attributes or `astro-` class
4. use of `_astro/` directory

Attempts to be fast and not download more than needed, but will try to wait for the entire head to get a good faith attempt to find the generator tag because it's nice to see the version

The main logic is in [lib/modules/server](./src/lib/modules/server/index.ts)

There are [some tests](./src/lib/test/index.ts) run with `pnpm test`

There is an `/api` route for JSON that will return

```js
{
    url: string;
    isAstro: boolean;
    mechanism: string;
    lastFetchedUrl?: string;
    astroVersion?: string;
    starlightVersion?: string;
}
```
