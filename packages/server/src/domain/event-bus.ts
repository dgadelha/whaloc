import type { WsEvent } from "@whaloc/shared";

/**
 * The seam between the domain services and the control-plane WebSocket (SPEC §5).
 *
 * Services publish; they never learn who is listening. The WS hub in `control-api/` is the
 * only subscriber in a running server, which is what keeps Hono out of the domain — swapping
 * the transport (SSE, a test spy) is a matter of subscribing something else.
 */
export interface EventPublisher {
	publish: (event: WsEvent) => void;
}

export type EventListener = (event: WsEvent) => void;

export interface EventBus extends EventPublisher {
	/** Registers a listener; call the returned function to stop receiving events. */
	subscribe: (listener: EventListener) => () => void;
}

export interface CreateEventBusOptions {
	/** Called when a listener throws, so one broken client cannot break the others. */
	onListenerError?: (error: unknown) => void;
}

export function createEventBus(options: CreateEventBusOptions = {}): EventBus {
	const listeners = new Set<EventListener>();

	return {
		publish: event => {
			for (const listener of listeners) {
				try {
					listener(event);
				} catch (error) {
					options.onListenerError?.(error);
				}
			}
		},
		subscribe: listener => {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** Publishes nowhere — the default for unit tests and for services built without a hub. */
export const noopEventPublisher: EventPublisher = {
	publish: () => {
		// Intentionally empty.
	},
};
