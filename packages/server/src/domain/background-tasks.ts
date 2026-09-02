import type { Logger } from "../logging/index.ts";

/**
 * Fire-and-forget work with a handle on it.
 *
 * Webhook deliveries must never make a caller wait: a `POST /{phoneNumberId}/messages` answers
 * as fast as Meta does even when the receiver is retrying three times (SPEC §3), and a control
 * -plane action answers as soon as the state changed. But work that nobody awaits is work a
 * test cannot assert on, so every such task is tracked and {@link BackgroundTasks.whenIdle}
 * waits for the ones in flight — including the ones they started in turn.
 */
export interface BackgroundTasks {
	/** Starts `task`; a rejection is logged, never thrown at whoever happened to be running. */
	run: (task: () => Promise<unknown>) => void;
	/** Resolves once nothing is in flight. Used by the specs and by the shutdown sequence. */
	whenIdle: () => Promise<void>;
	readonly size: number;
}

export function createBackgroundTasks(logger: Logger): BackgroundTasks {
	const inFlight = new Set<Promise<void>>();

	/** Swallows the rejection, so nothing that awaits the tracked promise ever throws. */
	const guard = async (task: () => Promise<unknown>): Promise<void> => {
		try {
			await task();
		} catch (error) {
			logger.error({ err: error }, "background task failed");
		}
	};

	const untrack = async (promise: Promise<void>): Promise<void> => {
		await promise;
		inFlight.delete(promise);
	};

	return {
		run: task => {
			const promise = guard(task);

			inFlight.add(promise);
			void untrack(promise);
		},
		whenIdle: async () => {
			// A task can start another one (a status webhook after a status transition), so
			// settle what is in flight and look again.
			while (inFlight.size > 0) {
				await Promise.all(inFlight);
			}
		},
		get size() {
			return inFlight.size;
		},
	};
}
