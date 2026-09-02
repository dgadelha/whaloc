import { upgradeWebSocket } from "@hono/node-server";
import type { WsEvent } from "@whaloc/shared";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { EventBus } from "../domain/index.ts";
import type { Logger } from "../logging/index.ts";
import type { ControlEnv } from "./control-env.ts";

export interface WsRoutesOptions {
	events: EventBus;
	logger: Logger;
}

/**
 * The control-plane WebSocket, `GET /api/ws` (SPEC §5).
 *
 * It is a pure fan-out: every connected client subscribes to the domain's event bus and gets
 * `{type, payload}` frames as things happen; nothing a client sends is read. That keeps the UI
 * a *pure* client of REST + WS — actions go through REST, state changes come back here — and
 * keeps the domain unaware that a socket exists at all.
 *
 * The upgrade helper comes from `@hono/node-server`, which has carried WebSocket support since
 * v2 (the server is created with a `noServer` `ws` server in `main.ts`). A disconnect
 * unsubscribes, and so does a failed send: a socket that throws is one whose client is gone.
 */
export function createWsRoutes(options: WsRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get(
		"/ws",
		upgradeWebSocket(() => {
			let unsubscribe: (() => void) | null = null;

			const stop = (): void => {
				unsubscribe?.();
				unsubscribe = null;
			};

			const send = (ws: WSContext, event: WsEvent): void => {
				try {
					ws.send(JSON.stringify(event));
				} catch (error) {
					options.logger.debug({ err: error }, "dropping a websocket client that could not be written to");
					stop();
				}
			};

			return {
				onOpen: (_event, ws) => {
					unsubscribe = options.events.subscribe(event => {
						send(ws, event);
					});
				},
				onClose: stop,
				onError: error => {
					options.logger.debug({ err: error }, "websocket client errored");
					stop();
				},
			};
		}),
	);

	return routes;
}
