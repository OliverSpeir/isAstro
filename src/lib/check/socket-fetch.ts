export type Connect = typeof import("cloudflare:sockets").connect;

const MAX_HEAD_BYTES = 65_536;
const BODYLESS_STATUSES = new Set([204, 205, 304]);

/**
 * A minimal HTTP/1.1 GET over a raw TCP/TLS socket. Unlike fetch() inside
 * Cloudflare, it returns the headers exactly as the server sent them.
 */
export async function socketFetch(
	connect: Connect,
	url: string,
	init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<Response> {
	init.signal.throwIfAborted();
	const target = new URL(url);
	const secure = target.protocol === "https:";
	const socket = connect(
		{ hostname: target.hostname, port: Number(target.port) || (secure ? 443 : 80) },
		{ secureTransport: secure ? "on" : "off" },
	);
	const close = () => void socket.close().catch(() => undefined);
	init.signal.addEventListener("abort", close, { once: true });

	const requestHead = [
		`GET ${target.pathname}${target.search} HTTP/1.1`,
		`Host: ${target.host}`,
		...Object.entries(init.headers).map(([name, value]) => `${name}: ${value}`),
		"Accept-Encoding: gzip, deflate",
		"Connection: close",
		"",
		"",
	].join("\r\n");
	const writer = socket.writable.getWriter();
	await writer.write(new TextEncoder().encode(requestHead));
	writer.releaseLock();

	const input = bufferedReader(socket.readable.getReader());
	let status: number;
	let headers: Headers;
	do {
		// Skip interim 1xx responses (e.g. 103 Early Hints).
		status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(await input.line())?.[1]);
		if (!(status >= 100 && status <= 599)) throw new Error("Malformed HTTP response");
		headers = new Headers();
		for (let line = await input.line(); line !== ""; line = await input.line()) {
			const colon = line.indexOf(":");
			try {
				headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
			} catch {
				// Skip header lines the Headers API rejects.
			}
		}
	} while (status < 200);

	if (BODYLESS_STATUSES.has(status)) {
		close();
		return new Response(null, { status, headers });
	}
	const chunks = bodyChunks(input, headers);
	const body = new ReadableStream<BufferSource>({
		async pull(controller) {
			const next = await chunks.next();
			if (next.done) {
				controller.close();
				close();
			} else controller.enqueue(next.value);
		},
		cancel: close,
	});
	const encoding = headers.get("content-encoding")?.trim().toLowerCase();
	const format =
		encoding === "gzip" || encoding === "x-gzip"
			? "gzip"
			: encoding === "deflate"
				? encoding
				: undefined;
	return new Response(format ? body.pipeThrough(new DecompressionStream(format)) : body, {
		status,
		headers,
	});
}

type BufferedReader = ReturnType<typeof bufferedReader>;

/** Buffers a byte stream so the response head can be read line by line. */
function bufferedReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const decoder = new TextDecoder();
	let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

	async function fill(): Promise<boolean> {
		const { value, done } = await reader.read();
		if (done) return false;
		const joined = new Uint8Array(buffer.length + value.length);
		joined.set(buffer);
		joined.set(value, buffer.length);
		buffer = joined;
		return true;
	}

	return {
		/** The next line without its line ending. */
		async line(): Promise<string> {
			for (;;) {
				const end = buffer.indexOf(10);
				if (end !== -1) {
					const line = decoder.decode(buffer.subarray(0, end)).replace(/\r$/, "");
					buffer = buffer.subarray(end + 1);
					return line;
				}
				if (buffer.length > MAX_HEAD_BYTES || !(await fill())) {
					throw new Error("Connection closed mid-head");
				}
			}
		},
		/** Up to `maxBytes` of what's buffered (reading more if empty); undefined once the stream ends. */
		async bytes(maxBytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
			if (buffer.length === 0 && !(await fill())) return undefined;
			const bytes = buffer.subarray(0, Math.min(maxBytes, buffer.length));
			buffer = buffer.subarray(bytes.length);
			return bytes;
		},
	};
}

/** Body bytes, framed by chunked encoding, content-length, or connection close. */
async function* bodyChunks(
	input: BufferedReader,
	headers: Headers,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	const chunked = /chunked/i.test(headers.get("transfer-encoding") ?? "");
	const contentLength = headers.get("content-length");
	let remaining = chunked ? 0 : contentLength === null ? Infinity : Number(contentLength);
	for (;;) {
		if (chunked && remaining === 0) {
			remaining = parseInt(await input.line(), 16);
			if (!remaining) return;
		}
		while (remaining > 0) {
			const bytes = await input.bytes(remaining);
			if (!bytes) return;
			remaining -= bytes.length;
			yield bytes;
		}
		if (!chunked) return;
		await input.line();
	}
}
