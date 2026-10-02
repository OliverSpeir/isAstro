export type Connect = typeof import("cloudflare:sockets").connect;

const MAX_HEAD_BYTES = 65_536;

/**
 * Sends a GET over a raw TCP/TLS socket and reads only the response head.
 * Unlike fetch() inside Cloudflare, the headers are exactly what the server sent.
 */
export async function socketHead(
	connect: Connect,
	url: string,
	init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<{ status: number; headers: Headers }> {
	init.signal.throwIfAborted();
	const target = new URL(url);
	const secure = target.protocol === "https:";
	const socket = connect(
		{ hostname: target.hostname, port: Number(target.port) || (secure ? 443 : 80) },
		{ secureTransport: secure ? "on" : "off" },
	);
	const close = () => void socket.close().catch(() => undefined);
	init.signal.addEventListener("abort", close, { once: true });

	try {
		// Workers refuse some connections here, before any bytes are sent.
		await socket.opened;
		const requestHead = [
			`GET ${target.pathname}${target.search} HTTP/1.1`,
			`Host: ${target.host}`,
			...Object.entries(init.headers).map(([name, value]) => `${name}: ${value}`),
			"Connection: close",
			"",
			"",
		].join("\r\n");
		const writer = socket.writable.getWriter();
		await writer.write(new TextEncoder().encode(requestHead));
		writer.releaseLock();

		const lines = headLines(socket.readable.getReader());
		for (;;) {
			const statusLine = (await lines.next()).value;
			const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
			if (!(status >= 100 && status <= 599)) throw new Error("Malformed HTTP response");
			const headers = new Headers();
			for (let line = await lines.next(); line.value; line = await lines.next()) {
				const colon = line.value.indexOf(":");
				try {
					headers.append(line.value.slice(0, colon).trim(), line.value.slice(colon + 1).trim());
				} catch {
					// Skip header lines the Headers API rejects.
				}
			}
			// Interim 1xx responses (e.g. 103 Early Hints) precede the real one.
			if (status >= 200) return { status, headers };
		}
	} finally {
		init.signal.removeEventListener("abort", close);
		close();
	}
}

/** Yields lines (without line endings) until the stream ends or the head grows too large. */
async function* headLines(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string, never> {
	const decoder = new TextDecoder();
	let buffered = "";
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		buffered += decoder.decode(chunk.value, { stream: true });
		let end = buffered.indexOf("\n");
		while (end !== -1) {
			yield buffered.slice(0, end).replace(/\r$/, "");
			buffered = buffered.slice(end + 1);
			end = buffered.indexOf("\n");
		}
		if (buffered.length > MAX_HEAD_BYTES) throw new Error("Response head too large");
	}
	throw new Error("Connection closed mid-head");
}
