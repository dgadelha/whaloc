import { wsEventSchema, type WsEvent } from "@whaloc/shared";

/**
 * The control-plane WebSocket client (SPEC §5).
 *
 * `/api/ws` is a one-way fan-out: whaloc pushes `{type, payload}` frames and reads nothing
 * back, so this is a subscription with a reconnect policy and no protocol of its own. The
 * backoff grows 500 ms → 8 s with jitter, because the socket dies every time the dev server
 * restarts and a tight retry loop would be the loudest thing in the log.
 *
 * A frame that does not parse is dropped rather than thrown: the UI stays live on the events
 * it does understand, which matters when the server is a version ahead of the bundle.
 */

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface WsClientOptions {
	onEvent: (event: WsEvent) => void;
	onStatus: (status: ConnectionStatus) => void;
	/** Overridden by tests; defaults to `/api/ws` on the page's own origin. */
	url?: string;
	onParseError?: (error: unknown) => void;
}

const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

export function defaultWsUrl(): string {
	const { protocol, host } = globalThis.location;

	return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/ws`;
}

/** Full jitter, so a server restart does not bring every open tab back in lockstep. */
export function backoffDelay(attempt: number): number {
	const ceiling = Math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * 2 ** attempt);

	return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Opens the socket and keeps it open; the returned function closes it for good. */
export function connectEvents(options: WsClientOptions): () => void {
	const url = options.url ?? defaultWsUrl();
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let attempt = 0;
	let isStopped = false;

	const open = (): void => {
		if (isStopped) {
			return;
		}

		options.onStatus("connecting");
		socket = new WebSocket(url);

		socket.addEventListener("open", () => {
			attempt = 0;
			options.onStatus("open");
		});

		socket.addEventListener("message", message => {
			const data: unknown = message.data;

			if (typeof data !== "string") {
				return;
			}

			try {
				options.onEvent(wsEventSchema.parse(JSON.parse(data)));
			} catch (error) {
				options.onParseError?.(error);
			}
		});

		socket.addEventListener("close", () => {
			socket = null;

			if (isStopped) {
				return;
			}

			options.onStatus("closed");
			retryTimer = setTimeout(open, backoffDelay(attempt));
			attempt += 1;
		});

		// `error` is always followed by `close`, which is where the retry is scheduled.
		socket.addEventListener("error", () => {
			options.onStatus("closed");
		});
	};

	open();

	return () => {
		isStopped = true;

		if (retryTimer !== null) {
			clearTimeout(retryTimer);
		}

		socket?.close();
		socket = null;
	};
}
