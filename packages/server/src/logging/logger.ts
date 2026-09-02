import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";
import type { LogLevel } from "../config/index.ts";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
	logLevel: LogLevel;
}

/**
 * Builds the envelope of one line: an ISO-8601 `timestamp`, the serialized `err` kept
 * top-level, and every other caller attribute nested under `context`. Runs on every log call
 * as pino's `log` formatter.
 */
function enhance(attributes: Record<string, unknown>): Record<string, unknown> {
	const { err, ...context } = attributes;
	const now = new Date();

	return {
		timestamp: now.toISOString(),
		...(err !== undefined && { err }),
		...(Object.keys(context).length > 0 && { context }),
	};
}

/**
 * The JSON envelope every line is written in — one shape for every service in a compose
 * stack to grep, ship and read the same way:
 *
 * ```json
 * {"level":"info","service":"whaloc","env":"development","timestamp":"2026-09-02T01:18:02.090Z",
 *  "context":{"port":8080},"message":"whaloc listening"}
 * ```
 *
 * - `level` is the label, not pino's integer
 * - `service`/`env` replace pino's default base (`pid`/`hostname` say nothing in a container)
 * - `timestamp`/`context` come from {@link enhance}; child-logger bindings (a request id) stay
 *   top-level, which is where a correlation field belongs
 * - `message`, not `msg`
 */
function envelopeOptions(level: LogLevel): LoggerOptions {
	return {
		level,
		base: { service: "whaloc", env: process.env["NODE_ENV"] ?? "development" },
		messageKey: "message",
		// pino's own `time` is off: `enhance` emits the timestamp, inside the envelope it builds.
		timestamp: false,
		formatters: {
			level: label => ({ level: label }),
			log: enhance,
		},
	};
}

export function createLogger(options: CreateLoggerOptions): PinoLogger {
	return pino(envelopeOptions(options.logLevel));
}
