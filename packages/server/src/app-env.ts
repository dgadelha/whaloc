import type { RequestLoggerVariables } from "./logging/index.ts";

/** Hono environment shared by every router mounted on the app. */
export interface AppEnv {
	Variables: RequestLoggerVariables;
}
