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

export function createMockResponse(chunks: string[], init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	if (!headers.has("content-type")) headers.set("content-type", "text/html");
	return new Response(createMockStream(chunks), { ...init, headers });
}

export type FetchCall = {
	url: string;
	init: RequestInit | undefined;
};

export function createSequenceFetch(
	responses: Response[],
	calls: FetchCall[] = [],
): typeof globalThis.fetch {
	let index = 0;
	return (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init });
		const response = responses[index++];
		if (!response) return Promise.reject(new Error(`Unexpected fetch for ${url}`));
		return Promise.resolve(response);
	};
}

/**
 * Overrides globalThis.fetch so isAstroWebsite uses this mock.
 * @param htmlChunks HTML content to provide in multiple chunks
 * @param contentType Mime type, defaults to text/html
 * @returns A function that restores the fetch implementation this call replaced
 */
export function mockFetchResponse(htmlChunks: string[], contentType = "text/html") {
	const previousFetch = globalThis.fetch;
	const mockFetch: typeof globalThis.fetch = (_input, _init) => {
		const headers = new Headers({ "content-type": contentType });
		const body = createMockStream(htmlChunks);
		return Promise.resolve(
			new Response(body, {
				headers,
				status: 200,
				statusText: "OK",
			}),
		);
	};

	globalThis.fetch = mockFetch;

	return () => {
		if (globalThis.fetch === mockFetch) {
			globalThis.fetch = previousFetch;
		}
	};
}
