import { resetResponseSchema, stateResponseSchema } from "@whaloc/shared";
import { Hono } from "hono";
import type { ResetService, StateService } from "../domain/index.ts";
import type { ControlEnv } from "./control-env.ts";

export interface StateRoutesOptions {
	state: StateService;
	reset: ResetService;
}

/**
 * `GET /api/state` and `POST /api/reset` (SPEC §5) — what the UI loads with, and the button
 * that puts whaloc back the way it booted.
 *
 * Both answers are parsed through the shared schema before they go out, so a drift between
 * the server and the contract the UI imports fails here instead of in the browser.
 */
export function createStateRoutes(options: StateRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/state", async c => c.json(stateResponseSchema.parse(await options.state.snapshot())));

	routes.post("/reset", async c => {
		const { state } = await options.reset.reset();

		return c.json(resetResponseSchema.parse({ data: state }));
	});

	return routes;
}
