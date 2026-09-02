import type { Logger } from "./logging/index.ts";

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GracefulShutdownOptions {
	logger: Logger;
	/** Stops accepting connections and resolves once in-flight requests are done. */
	close: () => Promise<void>;
	signals?: readonly NodeJS.Signals[];
	timeoutMs?: number;
}

/**
 * Closes the server on `SIGTERM`/`SIGINT` (Docker stop, Ctrl+C) and lets the process exit on
 * its own once nothing is pending. A stuck connection is given `timeoutMs` before the process
 * is killed with a non-zero status.
 */
export function registerShutdownHandlers(options: GracefulShutdownOptions): void {
	const { close, logger } = options;
	const signals = options.signals ?? DEFAULT_SIGNALS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let isShuttingDown = false;

	async function shutdown(signal: NodeJS.Signals): Promise<void> {
		if (isShuttingDown) {
			logger.warn({ signal }, "shutdown already in progress, ignoring signal");

			return;
		}

		isShuttingDown = true;
		logger.info({ signal }, "shutting down");

		const forceExit = setTimeout(() => {
			logger.error({ timeoutMs }, "shutdown timed out, exiting now");
			process.exit(1);
		}, timeoutMs);

		// Never let the timeout itself keep the process alive.
		forceExit.unref();

		try {
			await close();
			logger.info("shutdown complete");
		} catch (error) {
			logger.error({ err: error }, "shutdown failed");
			process.exitCode = 1;
		} finally {
			clearTimeout(forceExit);
		}
	}

	for (const signal of signals) {
		process.once(signal, () => {
			void shutdown(signal);
		});
	}
}
