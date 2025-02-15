import { ReadableStream } from "node:stream/web";

/**
 * Creates a streaming body from multiple string chunks.
 * Each pull enqueues one chunk until done.
 */
export function createMockStream(chunks: string[]) {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				const encoded = new TextEncoder().encode(chunks[index]);
				controller.enqueue(encoded);
				index++;
			} else {
				controller.close();
			}
		},
	});
}

/**
 * Overrides globalThis.fetch so isAstroWebsite uses this mock.
 * @param htmlChunks HTML content to provide in multiple chunks
 * @param contentType Mime type, defaults to text/html
 */
export function mockFetchResponse(htmlChunks: string[], contentType = "text/html") {
	globalThis.fetch = function mockFetch(_input, _init) {
		const headers = new Headers({ "content-type": contentType });
		const body = createMockStream(htmlChunks);
		return Promise.resolve(
			new Response(body, {
				headers,
				status: 200,
				statusText: "OK",
			}),
		);
	} as typeof globalThis.fetch;
}
