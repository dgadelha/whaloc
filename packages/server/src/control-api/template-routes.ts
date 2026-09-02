import {
	listTemplatesQuerySchema,
	rejectTemplateRequestSchema,
	templateListResponseSchema,
	templateQualityRequestSchema,
	templateResponseSchema,
} from "@whaloc/shared";
import { Hono, type Context } from "hono";
import type { TemplateRecord } from "../db/index.ts";
import { toTemplateDto, type TemplateLifecycle, type TemplateService } from "../domain/index.ts";
import { controlError, parseOrThrow, readBody, readOptionalJsonBody, type ControlEnv } from "./control-env.ts";

export interface TemplateRoutesOptions {
	templates: TemplateService;
	templateLifecycle: TemplateLifecycle;
}

/** Every action answers the same way: the template as it now stands, or a 404. */
function answer(c: Context<ControlEnv>, templateId: string, template: TemplateRecord | null): Response {
	return template === null
		? controlError(c, 404, `no template with ID ${templateId}`, "unknown_template")
		: c.json(templateResponseSchema.parse({ data: toTemplateDto(template) }));
}

/**
 * Template moderation from the control plane (SPEC §5): what a Meta reviewer would do, on
 * demand. Every action persists the new status and emits the matching webhook.
 */
export function createTemplateRoutes(options: TemplateRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	// The filters are the Graph listing's, applied server-side so the UI's filter bar and a
	// consumer's `GET /{wabaId}/message_templates?status=` mean the same thing (SPEC §2.8).
	routes.get("/templates", async c => {
		const { search, ...query } = parseOrThrow(listTemplatesQuerySchema, c.req.query());
		const templates = await options.templates.listAll({
			...query,
			...(search !== undefined && { nameOrContent: search }),
		});

		return c.json(templateListResponseSchema.parse({ data: templates.map(template => toTemplateDto(template)) }));
	});

	routes.post("/templates/:id/approve", async c => {
		const id = c.req.param("id");

		return answer(c, id, await options.templateLifecycle.approve(id));
	});

	routes.post("/templates/:id/reject", async c => {
		// The body is optional: a bare `POST` from a UI button rejects with the defaults.
		const body = parseOrThrow(rejectTemplateRequestSchema, await readOptionalJsonBody(c));
		const id = c.req.param("id");

		return answer(c, id, await options.templateLifecycle.reject(id, body));
	});

	routes.post("/templates/:id/pause", async c => {
		const id = c.req.param("id");

		return answer(c, id, await options.templateLifecycle.pause(id));
	});

	routes.post("/templates/:id/disable", async c => {
		const id = c.req.param("id");

		return answer(c, id, await options.templateLifecycle.disable(id));
	});

	routes.post("/templates/:id/quality", async c => {
		const body = await readBody(c, templateQualityRequestSchema);
		const id = c.req.param("id");

		return answer(c, id, await options.templateLifecycle.setQualityScore(id, body.qualityScore));
	});

	return routes;
}
