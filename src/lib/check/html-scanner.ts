/**
 * Streaming, single-pass HTML scanner that looks for Astro evidence.
 *
 * States: text → tag | comment | raw-text (script/style/…) → text.
 * Phases: head → body. Head ends at </head>, <body>, or the first tag that
 * can't live in <head> (so minified pages that omit optional tags still work).
 *
 * Decision rules:
 * - A generator meta tag or marker in <head> decides at the end of <head>, so
 *   we can report the version even when an asset marker came first.
 * - In <body>, the first marker decides immediately.
 * - A meta refresh in <head> is followed like a redirect.
 */

import type { Verdict } from "./types";

export type ScanResult =
	| Extract<Verdict, { status: "astro" | "not-astro" }>
	| { status: "meta-refresh"; location: string };

/** [label, pattern]: each label is reported once as evidence. */
type Marker = readonly [string, RegExp];

type Mode =
	| { name: "text" }
	| { name: "comment" }
	| { name: "raw-text"; element: string; closer: RegExp; markers: readonly Marker[] };

const MAX_CARRY_LENGTH = 16_384;
const RAW_TEXT_OVERLAP_LENGTH = 64;

/** Elements whose contents are not markup (or are examples of markup). */
const RAW_TEXT_ELEMENTS = new Set([
	"script",
	"style",
	"textarea",
	"template",
	"pre",
	"title",
	"xmp",
]);
const HEAD_ELEMENTS = new Set([
	"html",
	"head",
	"meta",
	"link",
	"title",
	"style",
	"script",
	"noscript",
	"base",
	"template",
]);

const TAG_NAME = /^<(\/?)([a-zA-Z][\w:-]*)/;
const ATTRIBUTE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const GENERATOR_CONTENT = /^(Astro|Starlight)(?:\s+(.+))?$/i;
const META_REFRESH_CONTENT = /^\s*\d+(?:\.\d+)?\s*[;,]\s*url\s*=\s*(.*?)\s*$/i;

const TAG_MARKERS: readonly Marker[] = [
	["data-astro-* attribute", /\sdata-astro-[\w-]+/],
	["scoped astro-* class", /\sclass\s*=\s*(?:"[^"]*|'[^']*|[^\s>]*)\bastro-[a-zA-Z0-9]{8}\b/],
	["_astro/ asset", /["'=\s,(](?:[^"'\s>(),=]*\/)?_astro\//],
];
const STYLE_MARKERS: readonly Marker[] = [
	["scoped style selector", /:where\(\.astro-[a-zA-Z0-9]{8}\)|\[data-astro-[\w-]+/],
];
// Only inline module scripts: Astro emits its scripts that way, while frameworks
// like Next.js stream page text (which may quote Astro code) in classic scripts.
const MODULE_SCRIPT_MARKERS: readonly Marker[] = [
	[
		"astro:* event listener",
		/["'`]astro:(?:page-load|after-swap|before-swap|before-preparation|after-preparation)["'`]/,
	],
	["server island", /\/_server-islands\//],
];

export function createPageScanner(baseUrl: string) {
	let carry = "";
	let mode: Mode = { name: "text" };
	let inHead = true;
	let rawTextTail = "";
	let astroGenerator: { version?: string } | undefined;
	let starlightGenerator: { version?: string } | undefined;
	const markers = new Set<string>();

	function findMarkers(text: string, candidates: readonly Marker[]): void {
		for (const [label, pattern] of candidates) if (pattern.test(text)) markers.add(label);
	}

	function astroResult(): ScanResult | undefined {
		if (!astroGenerator && !starlightGenerator && markers.size === 0) return undefined;
		// Strongest first: the generator tag is conclusive, markers corroborate it.
		const evidence = [
			...(astroGenerator ? [generatorEvidence("Astro", astroGenerator.version)] : []),
			...markers,
		];
		const starlightEvidence = starlightGenerator
			? [generatorEvidence("Starlight", starlightGenerator.version)]
			: [];
		return {
			status: "astro",
			starlight: Boolean(starlightGenerator),
			...(astroGenerator?.version && { astroVersion: astroGenerator.version }),
			...(starlightGenerator?.version && { starlightVersion: starlightGenerator.version }),
			// Starlight is built on Astro, so its tag alone also proves Astro.
			evidence: evidence.length > 0 ? evidence : starlightEvidence,
			...(starlightGenerator && { starlightEvidence }),
		};
	}

	function endHead(): ScanResult | undefined {
		inHead = false;
		return astroResult();
	}

	function handleTag(tag: string): ScanResult | undefined {
		const nameMatch = TAG_NAME.exec(tag);
		if (!nameMatch?.[2]) return undefined;
		const closing = nameMatch[1] === "/";
		const name = nameMatch[2].toLowerCase();

		if (inHead) {
			const leavesHead = closing ? name === "head" : !HEAD_ELEMENTS.has(name);
			if (leavesHead) {
				const decided = endHead();
				if (decided || closing) return decided;
			} else if (!closing && name === "meta") {
				const refresh = handleHeadMeta(tag);
				if (refresh) return refresh;
			}
		}
		if (closing) return undefined;

		if (RAW_TEXT_ELEMENTS.has(name)) {
			const isModuleScript =
				name === "script" && parseAttributes(tag).get("type")?.trim().toLowerCase() === "module";
			const rawTextMarkers =
				name === "style" ? STYLE_MARKERS : isModuleScript ? MODULE_SCRIPT_MARKERS : [];
			mode = {
				name: "raw-text",
				element: name,
				closer: new RegExp(`</${name}`, "gi"),
				markers: rawTextMarkers,
			};
			rawTextTail = "";
		}
		if (name.startsWith("astro-")) markers.add("astro-* element");
		findMarkers(tag, TAG_MARKERS);
		return inHead ? undefined : astroResult();
	}

	function handleHeadMeta(tag: string): ScanResult | undefined {
		const attributes = parseAttributes(tag);
		if (attributes.get("name")?.trim().toLowerCase() === "generator") {
			const match = GENERATOR_CONTENT.exec(attributes.get("content")?.trim() ?? "");
			if (match?.[1]) {
				const generator = { ...(match[2] && { version: match[2].trim() }) };
				if (match[1].toLowerCase() === "astro") astroGenerator ??= generator;
				else starlightGenerator ??= generator;
			}
			return undefined;
		}
		if (attributes.get("http-equiv")?.trim().toLowerCase() !== "refresh") return undefined;
		const target = META_REFRESH_CONTENT.exec(attributes.get("content") ?? "")?.[1]
			?.replace(/^(["'])(.*)\1$/, "$2")
			.trim();
		if (!target) return undefined;
		try {
			return { status: "meta-refresh", location: new URL(target, baseUrl).toString() };
		} catch {
			return undefined;
		}
	}

	/** Scans raw text with a small overlap so markers split across chunks still match. */
	function handleRawText(text: string, candidates: readonly Marker[]): void {
		if (candidates.length === 0) return;
		const window = rawTextTail + text;
		findMarkers(window, candidates);
		rawTextTail = window.slice(-RAW_TEXT_OVERLAP_LENGTH);
	}

	/** Feed decoded text. Returns a result as soon as the page is decided. */
	function write(chunk: string): ScanResult | undefined {
		const input = carry + chunk;
		carry = "";
		let index = 0;

		while (index < input.length) {
			if (mode.name === "raw-text") {
				mode.closer.lastIndex = index;
				const close = mode.closer.exec(input);
				const textEnd = close
					? close.index
					: Math.max(index, input.length - mode.element.length - 1);
				handleRawText(input.slice(index, textEnd), mode.markers);
				if (!close) {
					carry = input.slice(textEnd);
					break;
				}
				mode = { name: "text" };
				index = close.index;
				if (!inHead) {
					const decided = astroResult();
					if (decided) return decided;
				}
				continue;
			}

			if (mode.name === "comment") {
				const end = input.indexOf("-->", index);
				if (end === -1) {
					carry = input.slice(-2);
					break;
				}
				mode = { name: "text" };
				index = end + 3;
				continue;
			}

			const tagStart = input.indexOf("<", index);
			if (tagStart === -1) break;
			if (input.startsWith("<!--", tagStart)) {
				mode = { name: "comment" };
				index = tagStart + 4;
				continue;
			}
			const tagEnd = findTagEnd(input, tagStart);
			if (tagEnd === -1) {
				const partial = input.slice(tagStart);
				if (partial.length <= MAX_CARRY_LENGTH) {
					carry = partial;
					break;
				}
				// Oversized tag (e.g. an island's inline props): judge it by its opening, then drop it.
				return handleTag(partial);
			}
			const decided = handleTag(input.slice(tagStart, tagEnd + 1));
			if (decided) return decided;
			index = tagEnd + 1;
		}
		return undefined;
	}

	/** Call once the body is exhausted. */
	function end(): ScanResult {
		if (inHead) endHead();
		return astroResult() ?? { status: "not-astro" };
	}

	return { write, end };
}

/** Finds the closing ">" of a tag, honouring quoted attribute values. */
function findTagEnd(input: string, tagStart: number): number {
	let previousSignificant = "";
	for (let index = tagStart + 1; index < input.length; index++) {
		const character = input[index];
		if (character === ">") return index;
		if ((character === '"' || character === "'") && previousSignificant === "=") {
			const closingQuote = input.indexOf(character, index + 1);
			if (closingQuote === -1) return -1;
			index = closingQuote;
			previousSignificant = character;
			continue;
		}
		if (character !== " " && character !== "\n" && character !== "\t" && character !== "\r") {
			previousSignificant = character ?? "";
		}
	}
	return -1;
}

function parseAttributes(tag: string): Map<string, string> {
	const attributes = new Map<string, string>();
	ATTRIBUTE.lastIndex = TAG_NAME.exec(tag)?.[0].length ?? tag.length;
	for (let match = ATTRIBUTE.exec(tag); match; match = ATTRIBUTE.exec(tag)) {
		const name = match[1]?.toLowerCase();
		if (name && !attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
	}
	return attributes;
}

function generatorEvidence(name: "Astro" | "Starlight", version: string | undefined): string {
	return `generator meta tag "${name}${version ? ` ${version}` : ""}"`;
}
