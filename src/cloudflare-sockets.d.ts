/** The subset of the Workers TCP socket API that isAstro uses. */
declare module "cloudflare:sockets" {
	export function connect(
		address: { hostname: string; port: number },
		options: { secureTransport: "on" | "off" },
	): {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
		opened: Promise<unknown>;
		close(): Promise<void>;
	};
}
