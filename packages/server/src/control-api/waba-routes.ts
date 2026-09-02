import {
	wabaCreateRequestSchema,
	wabaListResponseSchema,
	wabaResponseSchema,
	wabaUpdateRequestSchema,
} from "@whaloc/shared";
import { Hono } from "hono";
import { toWabaDto, type WabaService } from "../domain/index.ts";
import { readBody, type ControlEnv } from "./control-env.ts";

export interface WabaRoutesOptions {
	wabas: WabaService;
}

/**
 * `GET/POST /api/wabas`, `PATCH|DELETE /api/wabas/:id` (SPEC §5) — the WABAs `WHALOC_SEED`
 * describes, plus whichever ones a dev adds while the container is running.
 *
 * A delete answers with the WABA that is gone rather than an empty body: the UI toasts its name,
 * and a script gets a confirmation it can log. Deleting the last one is allowed — an empty
 * whaloc is a legal state.
 */
export function createWabaRoutes(options: WabaRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/wabas", async c => {
		const wabas = await options.wabas.list();

		return c.json(wabaListResponseSchema.parse({ data: wabas.map(waba => toWabaDto(waba)) }));
	});

	routes.post("/wabas", async c => {
		const body = await readBody(c, wabaCreateRequestSchema);
		const waba = await options.wabas.create(body);

		return c.json(wabaResponseSchema.parse({ data: toWabaDto(waba) }), 201);
	});

	routes.patch("/wabas/:id", async c => {
		const body = await readBody(c, wabaUpdateRequestSchema);
		const waba = await options.wabas.rename(c.req.param("id"), body);

		return c.json(wabaResponseSchema.parse({ data: toWabaDto(waba) }));
	});

	routes.delete("/wabas/:id", async c => {
		const waba = await options.wabas.delete(c.req.param("id"));

		return c.json(wabaResponseSchema.parse({ data: toWabaDto(waba) }));
	});

	return routes;
}
