import { TEMPLATE_CATEGORIES, TEMPLATE_STATUSES } from "@whaloc/shared";
import { Hono } from "hono";
import { z } from "zod";
import {
	templateCreateRequestSchema,
	templateEditRequestSchema,
	type ListTemplatesInput,
	type TemplateService,
} from "../domain/index.ts";
import { parseFields, projectFields } from "./fields.ts";
import type { GraphEnv } from "./graph-env.ts";
import { templateNode } from "./object-routes.ts";
import { decodeCursor, encodeCursor, pagingOf } from "./paging.ts";
import { parseOrThrow, readJsonBody } from "./request-parsing.ts";

export interface TemplateRoutesOptions {
	templates: TemplateService;
	/** `WHALOC_PUBLIC_URL`; `paging.next` has to be reachable from another container (SPEC §1.7). */
	publicUrl: string;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const limitSchema = z
	.string()
	.regex(/^\d+$/, "must be a whole number")
	.transform(Number)
	.pipe(z.int().min(1).max(MAX_PAGE_SIZE))
	.optional();

const templateDeleteQuerySchema = z.object({
	name: z.string().min(1),
	hsm_id: z.string().min(1).optional(),
});

/**
 * Meta's filters on the listing (SPEC §2.8). All optional, all combinable, and combinable with
 * `fields` / `limit` / `after` / `before`; an unknown value is `(#100) Invalid parameter` rather
 * than an empty page, so a typo in a `status` is visible instead of looking like "no templates".
 */
const templateListQuerySchema = z.object({
	name: z.string().min(1).optional(),
	name_or_content: z.string().min(1).optional(),
	status: z.enum(TEMPLATE_STATUSES, `Param status must be one of ${TEMPLATE_STATUSES.join(", ")}`).optional(),
	category: z.enum(TEMPLATE_CATEGORIES, `Param category must be one of ${TEMPLATE_CATEGORIES.join(", ")}`).optional(),
	language: z.string().min(1).optional(),
});

type TemplateListQuery = z.infer<typeof templateListQuerySchema>;

/** Just the filtering half of what the service takes — the cursors are read separately. */
type TemplateFilters = Omit<ListTemplatesInput, "wabaId" | "limit" | "afterId" | "beforeId">;

/** Which page a `paging` URL points at: forward from the last row, or back from the first. */
type PageDirection = "after" | "before";

interface PageUrlOptions {
	publicUrl: string;
	version: string;
	wabaId: string;
	limit: number;
	/** The raw query string, so every filter the caller sent is carried into the link. */
	query: URLSearchParams;
	direction: PageDirection;
	cursorId: string;
}

/**
 * Built from `WHALOC_PUBLIC_URL` so the consumer can follow it from another container, and
 * carrying the caller's own `fields` and filters so the next page is the same listing.
 */
function pageUrl(options: PageUrlOptions): string {
	const url = new URL(`${options.publicUrl}/${options.version}/${options.wabaId}/message_templates`);

	for (const [key, value] of options.query) {
		if (key !== "limit" && key !== "after" && key !== "before") {
			url.searchParams.append(key, value);
		}
	}

	url.searchParams.set("limit", String(options.limit));
	url.searchParams.set(options.direction, encodeCursor(options.cursorId));

	return url.href;
}

/** The query filters, translated to the camelCase the domain speaks. */
function filtersOf(query: TemplateListQuery): TemplateFilters {
	return {
		...(query.name !== undefined && { name: query.name }),
		...(query.name_or_content !== undefined && { nameOrContent: query.name_or_content }),
		...(query.status !== undefined && { status: query.status }),
		...(query.category !== undefined && { category: query.category }),
		...(query.language !== undefined && { language: query.language }),
	};
}

/** Message template management (SPEC §2.7–§2.10). */
export function createTemplateRoutes(options: TemplateRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.post("/:id/message_templates", async c => {
		const request = parseOrThrow(templateCreateRequestSchema, await readJsonBody(c));
		const template = await options.templates.create(c.req.param("id"), request);

		return c.json({ id: template.id, status: template.status, category: template.category });
	});

	routes.get("/:id/message_templates", async c => {
		const wabaId = c.req.param("id");
		const after = c.req.query("after");
		const before = c.req.query("before");
		const limit = parseOrThrow(limitSchema, c.req.query("limit")) ?? DEFAULT_PAGE_SIZE;
		const filters = filtersOf(parseOrThrow(templateListQuerySchema, c.req.query()));
		const { templates, hasNextPage, hasPreviousPage } = await options.templates.list({
			wabaId,
			limit,
			...(after !== undefined && { afterId: decodeCursor(after) }),
			...(before !== undefined && { beforeId: decodeCursor(before, "before") }),
			...filters,
		});
		const fields = parseFields(c.req.query("fields"));
		const ids = templates.map(template => template.id);
		const first = ids[0];
		const last = ids.at(-1);
		const requestUrl = new URL(c.req.url);
		const query = requestUrl.searchParams;
		const link = (direction: PageDirection, cursorId: string): string =>
			pageUrl({ publicUrl: options.publicUrl, version: c.var.version, wabaId, limit, query, direction, cursorId });

		return c.json({
			data: templates.map(template => projectFields(templateNode(template), fields)),
			paging: pagingOf(ids, {
				...(hasNextPage && last !== undefined && { next: link("after", last) }),
				...(hasPreviousPage && first !== undefined && { previous: link("before", first) }),
			}),
		});
	});

	routes.delete("/:id/message_templates", async c => {
		const query = parseOrThrow(templateDeleteQuerySchema, {
			name: c.req.query("name"),
			hsm_id: c.req.query("hsm_id"),
		});

		await options.templates.delete({ wabaId: c.req.param("id"), name: query.name, hsmId: query.hsm_id });

		return c.json({ success: true });
	});

	// `POST /{id}` is Meta's template edit (SPEC §2.9); it sits at the same depth as
	// `GET /{id}`, and any other object id is reported as missing.
	routes.post("/:id", async c => {
		const request = parseOrThrow(templateEditRequestSchema, await readJsonBody(c));

		await options.templates.edit(c.req.param("id"), request);

		return c.json({ success: true });
	});

	return routes;
}
