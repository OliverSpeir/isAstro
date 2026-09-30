/** Reads a whole body as text, throwing once it exceeds `maxBytes` (chunked bodies included). */
export async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
	if (Number(response.headers.get("content-length")) > maxBytes)
		throw new Error("Response too large");
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new Error("Response too large");
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
		void response.body.cancel().catch(() => undefined);
	}
}
