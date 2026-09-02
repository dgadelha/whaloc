import {
	injectionRuleCreateRequestSchema,
	injectionRuleListResponseSchema,
	injectionRuleResponseSchema,
} from "@whaloc/shared";
import { Hono } from "hono";
import { toInjectionRuleDto, type InjectionService } from "../domain/index.ts";
import { readBody, type ControlEnv } from "./control-env.ts";

export interface InjectionRoutesOptions {
	injection: InjectionService;
}

/**
 * `GET/POST /api/injection-rules`, `DELETE /api/injection-rules/:id` (SPEC §4, §5) — the
 * deterministic failures a dev arms while the container is running.
 *
 * There is no `PATCH`: a rule is three decisions and a countdown, and editing one in place would
 * leave the question of what happens to the counters. Deleting and re-adding is unambiguous, and
 * a new rule always starts fully armed.
 *
 * `POST /api/reset` clears every rule, along with the rest of the state.
 */
export function createInjectionRoutes(options: InjectionRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/injection-rules", async c => {
		const rules = await options.injection.list();

		return c.json(injectionRuleListResponseSchema.parse({ data: rules.map(rule => toInjectionRuleDto(rule)) }));
	});

	routes.post("/injection-rules", async c => {
		const body = await readBody(c, injectionRuleCreateRequestSchema);
		const rule = await options.injection.create(body);

		return c.json(injectionRuleResponseSchema.parse({ data: toInjectionRuleDto(rule) }), 201);
	});

	// Answers with the rule that is gone, like the other deletes in the control plane (SPEC §5).
	routes.delete("/injection-rules/:id", async c => {
		const rule = await options.injection.delete(c.req.param("id"));

		return c.json(injectionRuleResponseSchema.parse({ data: toInjectionRuleDto(rule) }));
	});

	return routes;
}
