import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A throwaway HTTP server the webhook specs point whaloc at (SPEC §3).
 *
 * It captures the **raw request body as bytes**, which is the whole point: the signature
 * assertions have to compare what was hashed against what actually arrived, and reading the
 * body as parsed JSON would hide exactly the bug those tests exist to catch.
 */
export interface CapturedRequest {
	method: string;
	path: string;
	/** Header names are lower-cased by Node. */
	headers: Record<string, string>;
	body: string;
	rawBody: Buffer;
	query: URLSearchParams;
}

export interface CaptureResponse {
	status?: number;
	body?: string;
	headers?: Record<string, string>;
}

/** Decides what to answer; `attempt` is 1-based, so a responder can fail the first call. */
export type CaptureResponder = (request: CapturedRequest, attempt: number) => CaptureResponse;

export interface CaptureServer {
	url: string;
	requests: CapturedRequest[];
	/** Swaps the responder mid-test, e.g. to recover after a couple of failures. */
	respondWith: (responder: CaptureResponder) => void;
	close: () => Promise<void>;
}

const DEFAULT_RESPONDER: CaptureResponder = () => ({ status: 200, body: "ok" });

/** Node hands multi-valued headers back as arrays; the specs only ever want a string. */
function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
	const normalized: Record<string, string> = {};

	for (const [name, value] of Object.entries(headers)) {
		normalized[name] = Array.isArray(value) ? value.join(",") : (value ?? "");
	}

	return normalized;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];

	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk as Buffer));
	}

	return Buffer.concat(chunks);
}

function closeServer(server: Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close(error => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

export async function startCaptureServer(
	initialResponder: CaptureResponder = DEFAULT_RESPONDER,
): Promise<CaptureServer> {
	const requests: CapturedRequest[] = [];
	let responder = initialResponder;

	const handle = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
		const rawBody = await readBody(incoming);
		// A base is required to parse a path-only request target; nothing ever fetches it.
		// eslint-disable-next-line unicorn/prefer-https
		const url = new URL(incoming.url ?? "/", "http://capture.invalid");
		const captured: CapturedRequest = {
			method: incoming.method ?? "GET",
			path: url.pathname,
			headers: normalizeHeaders(incoming.headers),
			body: rawBody.toString("utf8"),
			rawBody,
			query: url.searchParams,
		};

		requests.push(captured);

		const answer = responder(captured, requests.filter(request => request.path === captured.path).length);

		outgoing.writeHead(answer.status ?? 200, { "content-type": "text/plain", ...answer.headers });
		outgoing.end(answer.body ?? "ok");
	};

	const server = createServer((incoming, outgoing) => {
		void handle(incoming, outgoing);
	});

	await new Promise<void>(resolve => {
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${String(address.port)}/meta-webhooks`,
		requests,
		respondWith: next => {
			responder = next;
		},
		close: () => closeServer(server),
	};
}
