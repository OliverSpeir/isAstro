/** Read a response body without allowing chunked responses to bypass a byte limit. */
export async function readResponseTextWithLimit(
	response: Response,
	maxBytes: number,
	errorMessage: string,
): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const declaredBytes = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
			throw new Error(errorMessage);
		}
	}

	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let bytesRead = 0;
	let completed = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) throw new Error(errorMessage);
			parts.push(decoder.decode(value, { stream: true }));
		}
		parts.push(decoder.decode());
		completed = true;
		return parts.join("");
	} finally {
		if (!completed) await reader.cancel().catch(() => undefined);
	}
}
