import { healthResponseSchema, type HealthResponse } from "@whaloc/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app-env.ts";

/**
 * `GET /health`, mounted twice by {@link createApp}: at the root for the Docker HEALTHCHECK
 * and under `/api` for the control plane (SPEC §5).
 */
export function createHealthRoutes(): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.get("/health", c => {
		const now = new Date();
		const body: HealthResponse = {
			status: "ok",
			uptimeSeconds: Math.floor(process.uptime()),
			timestamp: now.toISOString(),
		};

		// Checked against the shared schema the web UI parses this response with, so a drift
		// between the two packages fails here instead of in the browser.
		return c.json(healthResponseSchema.parse(body));
	});

	return routes;
}
