/**
 * Everything time-dependent goes through this interface: the status ladder's `setTimeout`s
 * (SPEC §4), the template auto-approval timer, and the webhook emitter's retry backoff
 * (SPEC §3). Injecting it means the specs can drive those with fake timers, or with a
 * scheduler that records the delays it was asked for instead of waiting them out.
 *
 * Timers are plain in-process `setTimeout`s and are **not** persisted: a restart drops
 * whatever was pending (SPEC §4). For a dev tool that is the right trade — the alternative is
 * a job table that replays a webhook storm on every boot.
 */
export interface ScheduledTask {
	/** Idempotent: cancelling an already-fired or already-cancelled task does nothing. */
	cancel: () => void;
}

export interface Scheduler {
	/** Runs `task` after `delayMs` (a delay of 0 still runs on a later tick). */
	schedule: (delayMs: number, task: () => void) => ScheduledTask;
	/** Waits `delayMs`; how the webhook emitter spaces its retries. */
	sleep: (delayMs: number) => Promise<void>;
	/** Now, as a `Date` — services never call the global clock directly. */
	now: () => Date;
}

/**
 * The real one. Timers are `unref`ed: a pending status ladder must never be the reason a
 * process stays alive, in a test run or after the HTTP server has closed.
 */
export function createSystemScheduler(): Scheduler {
	return {
		schedule: (delayMs, task) => {
			const timer = setTimeout(task, delayMs);

			timer.unref();

			return {
				cancel: () => {
					clearTimeout(timer);
				},
			};
		},
		sleep: async delayMs => {
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, delayMs);

				timer.unref();
			});
		},
		now: () => new Date(),
	};
}
