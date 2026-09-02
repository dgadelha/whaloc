import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

/** Per-request context every route can rely on. */
export interface RequestLoggerVariables {
	logger: Logger;
	requestId: string;
}

/** Health probes run every few seconds; they are logged at `debug` so the log stays readable. */
const DEFAULT_QUIET_PATHS = ["/health", "/api/health"] as const;

export interface RequestLoggerOptions {
	quietPaths?: readonly string[];
}

type CompletionLevel = "error" | "warn" | "info" | "debug";

function completionLevel(status: number, isQuiet: boolean): CompletionLevel {
	if (status >= 500) {
		return "error";
	}

	if (status >= 400) {
		return "warn";
	}

	return isQuiet ? "debug" : "info";
}

function elapsedMs(startedAt: number): number {
	return Math.round((performance.now() - startedAt) * 100) / 100;
}

/**
 * Attaches a request-scoped child logger (with a request id, echoed back as `x-request-id`)
 * and logs one line per completed request.
 */
export function createRequestLogger(
	logger: Logger,
	options: RequestLoggerOptions = {},
): MiddlewareHandler<{ Variables: RequestLoggerVariables }> {
	const quietPaths = new Set(options.quietPaths ?? DEFAULT_QUIET_PATHS);

	return async (c, next) => {
		const requestId = c.req.header("x-request-id") ?? randomUUID();
		const requestLogger = logger.child({ requestId });
		const { method } = c.req;
		const { path } = c.req;

		c.set("requestId", requestId);
		c.set("logger", requestLogger);

		const startedAt = performance.now();

		try {
			await next();
		} catch (error) {
			requestLogger.error({ method, path, durationMs: elapsedMs(startedAt), err: error }, "request failed");

			throw error;
		}

		const { status } = c.res;

		c.res.headers.set("x-request-id", requestId);
		requestLogger[completionLevel(status, quietPaths.has(path))](
			{ method, path, status, durationMs: elapsedMs(startedAt) },
			"request completed",
		);
	};
}
