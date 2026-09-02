import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SEED } from "../config/index.ts";
import { META_ID_PATTERN } from "../domain/index.ts";
import { anyString, readJson, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, TEST_PUBLIC_URL, type TestApp } from "../testing/test-app.ts";

interface TemplatePage {
	data: Record<string, unknown>[];
	paging: { cursors: { before: string; after: string }; next?: string; previous?: string };
}

/**
 * The built-in seed, minus the template it ships with (SPEC §7): the listings and cursors below
 * count the templates the test itself created, so they start from an empty table. The seeded
 * template's own behavior is covered by `domain/apply-seed.spec.ts` and the send specs. The
 * WABA is keyed on its name, so its id is the same either way.
 */
const SEED_WITHOUT_TEMPLATES = JSON.stringify(DEFAULT_SEED.map(waba => ({ ...waba, templates: [] })));

/** Reads the `after` cursor out of a `paging.next` URL. */
function afterCursorOf(next: string): string {
	const url = new URL(next);

	return url.searchParams.get("after") ?? "";
}

/** …and the `before` cursor out of a `paging.previous` one. */
function beforeCursorOf(previous: string): string {
	const url = new URL(previous);

	return url.searchParams.get("before") ?? "";
}

describe("message templates (SPEC §2.7-§2.10)", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp({ WHALOC_SEED: SEED_WITHOUT_TEMPLATES });
	});

	afterEach(async () => {
		await fixture.close();
	});

	function jsonRequest(path: string, method: string, body?: unknown) {
		return fixture.app.request(path, {
			method,
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			...(body !== undefined && { body: JSON.stringify(body) }),
		});
	}

	function create(overrides: Record<string, unknown> = {}) {
		return jsonRequest(`/v25.0/${fixture.wabaId}/message_templates`, "POST", {
			name: "order_update",
			language: "en_US",
			category: "UTILITY",
			components: [{ type: "BODY", text: "Order {{1}} ships on {{2}}" }],
			...overrides,
		});
	}

	async function createdId(overrides: Record<string, unknown> = {}): Promise<string> {
		const response = await create(overrides);
		const body = await readJson<{ id: string }>(response);

		return body.id;
	}

	function list(query = "") {
		return fixture.app.request(`/v25.0/${fixture.wabaId}/message_templates${query}`, { headers: TEST_AUTH_HEADERS });
	}

	async function listPage(query = ""): Promise<TemplatePage> {
		return readJson<TemplatePage>(await list(query));
	}

	async function createMany(count: number): Promise<string[]> {
		const ids: string[] = [];

		for (let index = 0; index < count; index += 1) {
			ids.push(await createdId({ name: `template_${String(index)}` }));
		}

		return ids;
	}

	describe("POST /:wabaId/message_templates", () => {
		it("creates a PENDING template and answers {id, status, category}", async () => {
			const response = await create();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				id: stringMatching(META_ID_PATTERN),
				status: "PENDING",
				category: "UTILITY",
			});
		});

		it("keeps template ids below 2^53 so they survive Meta's JSON numbers (SPEC §1.3)", async () => {
			const id = await createdId();

			expect(Number(id)).toBeLessThan(Number.MAX_SAFE_INTEGER);
			expect(String(Number(id))).toBe(id);
		});

		it("defaults parameter_format to POSITIONAL", async () => {
			const id = await createdId();

			expect(await fixture.services.repositories.templates.findById(id)).toMatchObject({
				parameterFormat: "POSITIONAL",
			});
		});

		it("stores parameter_format NAMED when asked", async () => {
			const id = await createdId({ parameter_format: "NAMED" });

			expect(await fixture.services.repositories.templates.findById(id)).toMatchObject({ parameterFormat: "NAMED" });
		});

		it("rejects a duplicate name and language with a Meta-shaped 400", async () => {
			await create();

			const response = await create();

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: {
					message: "(#100) Template name (order_update) and language (en_US) already exists",
					type: "OAuthException",
					code: 100,
					error_subcode: 2_388_024,
				},
			});
		});

		it("allows the same name in another language", async () => {
			await create();

			const response = await create({ language: "pt_BR" });

			expect(response.status).toBe(200);
		});

		it.each([
			{ label: "an upper-case name", overrides: { name: "Order_Update" } },
			{ label: "a hyphenated name", overrides: { name: "order-update" } },
			{ label: "an unknown category", overrides: { category: "PROMOTIONAL" } },
			{ label: "a malformed language", overrides: { language: "english" } },
			{ label: "empty components", overrides: { components: [] } },
			{ label: "components that are not an array", overrides: { components: { type: "BODY" } } },
		])("rejects $label", async ({ overrides }) => {
			const response = await create(overrides);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, message: "(#100) Invalid parameter" } });
		});

		it("reports an unknown WABA as a missing object", async () => {
			const response = await jsonRequest("/v25.0/777777777777777/message_templates", "POST", {
				name: "order_update",
				language: "en_US",
				category: "UTILITY",
				components: [{ type: "BODY", text: "Hi" }],
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});

	describe("GET /:wabaId/message_templates (SPEC §1.5, §2.8)", () => {
		it("lists templates with the fields Meta returns", async () => {
			const id = await createdId();
			const page = await listPage();

			expect(page.data).toEqual([
				{
					id,
					name: "order_update",
					language: "en_US",
					status: "PENDING",
					category: "UTILITY",
					parameter_format: "POSITIONAL",
					components: [{ type: "BODY", text: "Order {{1}} ships on {{2}}" }],
				},
			]);
		});

		it("honors fields", async () => {
			await create();

			const page = await listPage("?fields=name,status");

			expect(page.data).toEqual([{ name: "order_update", status: "PENDING", id: anyString() }]);
		});

		it("always reports cursors, even on an empty list", async () => {
			expect(await listPage()).toEqual({ data: [], paging: { cursors: { before: "", after: "" } } });
		});

		it("omits paging.next when the page is the last one", async () => {
			await createMany(3);

			const page = await listPage("?limit=3");

			expect(page.data).toHaveLength(3);
			expect(page.paging.next).toBeUndefined();
		});

		it("includes paging.next only while another page follows", async () => {
			await createMany(3);

			const page = await listPage("?limit=2");

			expect(page.data).toHaveLength(2);
			expect(page.paging.next).toContain(`${TEST_PUBLIC_URL}/v25.0/${fixture.wabaId}/message_templates`);
			expect(page.paging.next).toContain("limit=2");
		});

		it("walks every template through the after cursor, exactly once each", async () => {
			const created = await createMany(5);
			const seen: string[] = [];
			let cursor: string | undefined;

			do {
				const query = cursor === undefined ? "?limit=2" : `?limit=2&after=${encodeURIComponent(cursor)}`;
				const page = await listPage(query);

				seen.push(...page.data.map(template => String(template["id"])));
				cursor = page.paging.next === undefined ? undefined : afterCursorOf(page.paging.next);
			} while (cursor !== undefined);

			// The keyset runs on (created_at, id), so five templates created inside the same
			// millisecond come back ordered by id rather than by insertion.
			expect(seen).toHaveLength(created.length);
			expect(seen.toSorted((a, b) => a.localeCompare(b))).toEqual(created.toSorted((a, b) => a.localeCompare(b)));
		});

		it("carries fields into the next page URL", async () => {
			await createMany(2);

			const page = await listPage("?limit=1&fields=name");
			const next = new URL(page.paging.next ?? "");

			expect(next.searchParams.get("fields")).toBe("name");
		});

		it.each(["?limit=0", "?limit=abc", "?limit=1000"])("rejects %s", async query => {
			const response = await list(query);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100 } });
		});

		it("rejects a cursor that is not one of ours", async () => {
			const response = await list("?after=bm90LWEtY3Vyc29y");

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { error_data: { details: "Param after is not a valid cursor" } },
			});
		});

		it("names `before` when that is the cursor that was wrong", async () => {
			const response = await list("?before=bm90LWEtY3Vyc29y");

			expect(await response.json()).toMatchObject({
				error: { error_data: { details: "Param before is not a valid cursor" } },
			});
		});

		/** SPEC §1.5: `before` is the other half of the cursor pair, and now it works. */
		describe("the before cursor", () => {
			it("pages back onto the page it came from, oldest first", async () => {
				await createMany(5);

				const first = await listPage("?limit=2");
				const second = await listPage(`?limit=2&after=${encodeURIComponent(afterCursorOf(first.paging.next!))}`);

				expect(second.paging.previous).toContain("before=");

				const back = await listPage(`?limit=2&before=${encodeURIComponent(beforeCursorOf(second.paging.previous!))}`);

				// Paging back from the second page lands on the first one, in the same order.
				expect(back.data.map(template => String(template["id"]))).toEqual(
					first.data.map(template => String(template["id"])),
				);
				expect(back.paging.next).toContain("after=");
				expect(back.paging.previous).toBeUndefined();
			});

			it("has no previous link on the first page", async () => {
				await createMany(3);

				const page = await listPage("?limit=2");

				expect(page.paging.previous).toBeUndefined();
				expect(page.paging.next).toContain("after=");
			});

			it("walks the whole list backwards through previous, exactly once each", async () => {
				const created = await createMany(5);
				let page = await listPage("?limit=2");

				// Forward to the last page first: `before` only means something with history behind it.
				while (page.paging.next !== undefined) {
					page = await listPage(`?limit=2&after=${encodeURIComponent(afterCursorOf(page.paging.next))}`);
				}

				let seen = page.data.map(template => String(template["id"]));

				while (page.paging.previous !== undefined) {
					page = await listPage(`?limit=2&before=${encodeURIComponent(beforeCursorOf(page.paging.previous))}`);
					seen = [...page.data.map(template => String(template["id"])), ...seen];
				}

				const distinct = new Set(seen);

				expect(distinct.size).toBe(created.length);
				expect(seen.toSorted((a, b) => a.localeCompare(b))).toEqual(created.toSorted((a, b) => a.localeCompare(b)));
			});
		});

		/** The filters Meta documents (SPEC §2.8), combinable with each other and with paging. */
		describe("filters", () => {
			async function seedVariety(): Promise<void> {
				await createdId({ name: "order_update", components: [{ type: "BODY", text: "Order {{1}} shipped" }] });
				await createdId({
					name: "order_update",
					language: "pt_BR",
					components: [{ type: "BODY", text: "Pedido {{1}} enviado" }],
				});
				await createdId({
					name: "payment_reminder",
					category: "MARKETING",
					components: [{ type: "BODY", text: "Your invoice is due" }],
				});
			}

			async function names(query: string): Promise<string[]> {
				const page = await listPage(query);

				return page.data.map(template => String(template["name"]));
			}

			it("matches a name exactly", async () => {
				await seedVariety();

				expect(await names("?name=order_update")).toEqual(["order_update", "order_update"]);
				expect(await names("?name=order")).toEqual([]);
			});

			it("matches a substring of the name or of the content", async () => {
				await seedVariety();

				expect(await names("?name_or_content=payment")).toEqual(["payment_reminder"]);
				expect(await names("?name_or_content=invoice")).toEqual(["payment_reminder"]);
				expect(await names("?name_or_content=Pedido")).toEqual(["order_update"]);
			});

			it("treats the search as a literal, not as a LIKE pattern", async () => {
				await seedVariety();

				// `_` is a single-character wildcard in LIKE; escaped, it only matches itself.
				expect(await names("?name_or_content=order_update")).toHaveLength(2);
				expect(await names("?name_or_content=orderXupdate")).toEqual([]);
				expect(await names("?name_or_content=%25")).toEqual([]);
			});

			it("filters by status, category and language", async () => {
				await seedVariety();

				expect(await names("?status=PENDING")).toHaveLength(3);
				expect(await names("?status=APPROVED")).toEqual([]);
				expect(await names("?category=MARKETING")).toEqual(["payment_reminder"]);
				expect(await names("?language=pt_BR")).toEqual(["order_update"]);
			});

			it("combines filters, and combines them with fields", async () => {
				await seedVariety();

				const page = await listPage("?name=order_update&language=en_US&fields=name,language");

				expect(page.data).toEqual([{ name: "order_update", language: "en_US", id: anyString() }]);
			});

			it("keeps the paging.next rule under a filter (SPEC §1.5)", async () => {
				for (let index = 0; index < 3; index += 1) {
					await createdId({ name: `marketing_${String(index)}`, category: "MARKETING" });
				}

				await createdId({ name: "utility_one", category: "UTILITY" });

				const first = await listPage("?category=MARKETING&limit=2");

				expect(first.data).toHaveLength(2);
				expect(first.paging.next).toContain("category=MARKETING");

				const second = await listPage(
					`?limit=2&category=MARKETING&after=${encodeURIComponent(afterCursorOf(first.paging.next!))}`,
				);

				// One marketing template left, and the utility one is not in this listing at all.
				expect(second.data).toHaveLength(1);
				expect(second.paging.next).toBeUndefined();
			});

			it("carries every filter into the next page URL", async () => {
				await createdId({ name: "order_update" });
				await createdId({ name: "order_upgrade" });

				const page = await listPage("?limit=1&name_or_content=order&status=PENDING&fields=name");
				const next = new URL(page.paging.next ?? "");

				expect(next.searchParams.get("name_or_content")).toBe("order");
				expect(next.searchParams.get("status")).toBe("PENDING");
				expect(next.searchParams.get("fields")).toBe("name");
				expect(next.searchParams.get("limit")).toBe("1");
			});

			it.each(["?status=NOT_A_STATUS", "?category=PROMOTIONAL"])("rejects %s", async query => {
				const response = await list(query);

				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ error: { code: 100 } });
			});
		});
	});

	describe("GET /:templateId", () => {
		it("serves a template as a node read (SPEC §2.4)", async () => {
			const id = await createdId();
			const response = await fixture.app.request(`/v25.0/${id}`, { headers: TEST_AUTH_HEADERS });

			expect(await response.json()).toMatchObject({ id, name: "order_update", status: "PENDING" });
		});
	});

	describe("POST /:templateId (SPEC §2.9)", () => {
		it("edits the components and sends the template back to PENDING", async () => {
			const id = await createdId();

			await fixture.services.repositories.templates.update(id, { status: "APPROVED" });

			const response = await jsonRequest(`/v25.0/${id}`, "POST", {
				components: [{ type: "BODY", text: "Order {{1}} is ready" }],
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(await fixture.services.repositories.templates.findById(id)).toMatchObject({
				status: "PENDING",
				components: [{ type: "BODY", text: "Order {{1}} is ready" }],
			});
		});

		it("edits the category", async () => {
			const id = await createdId();

			await jsonRequest(`/v25.0/${id}`, "POST", { category: "MARKETING" });

			expect(await fixture.services.repositories.templates.findById(id)).toMatchObject({ category: "MARKETING" });
		});

		it("rejects an edit that changes nothing", async () => {
			const id = await createdId();
			const response = await jsonRequest(`/v25.0/${id}`, "POST", {});

			expect(response.status).toBe(400);
		});

		it("reports an unknown template as a missing object", async () => {
			const response = await jsonRequest("/v25.0/555555555555555", "POST", { category: "MARKETING" });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});

	describe("DELETE /:wabaId/message_templates (SPEC §2.10)", () => {
		function remove(query: string) {
			return fixture.app.request(`/v25.0/${fixture.wabaId}/message_templates${query}`, {
				method: "DELETE",
				headers: TEST_AUTH_HEADERS,
			});
		}

		it("deletes every language of a name", async () => {
			await create();
			await create({ language: "pt_BR" });

			const response = await remove("?name=order_update");

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(await fixture.services.repositories.templates.findByName(fixture.wabaId, "order_update")).toEqual([]);
		});

		it("deletes only the language hsm_id names", async () => {
			const id = await createdId();

			await create({ language: "pt_BR" });
			await remove(`?name=order_update&hsm_id=${id}`);

			const left = await fixture.services.repositories.templates.findByName(fixture.wabaId, "order_update");

			expect(left.map(template => template.language)).toEqual(["pt_BR"]);
		});

		it("answers 404 with an error envelope for an unknown name", async () => {
			const response = await remove("?name=never_created");

			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				error: {
					message: "(#100) Message template name (never_created) does not exist",
					type: "OAuthException",
					code: 100,
				},
			});
		});

		it("answers 404 when hsm_id names a template of another name", async () => {
			const id = await createdId();

			await create({ name: "other_template" });

			const response = await remove(`?name=other_template&hsm_id=${id}`);

			expect(response.status).toBe(404);
		});

		it("requires the name query parameter", async () => {
			const response = await remove("");

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, message: "(#100) Invalid parameter" } });
		});
	});
});
