import { injectionRuleListResponseSchema, injectionRuleResponseSchema, type WsEvent } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson, statusOf } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * `GET/POST /api/injection-rules` and `DELETE /api/injection-rules/:id` (SPEC §4, §5).
 *
 * Answers are parsed through the shared schemas, so a drift between the server and the contract
 * the UI imports fails here rather than in the browser.
 */
describe("control plane: injection rules", () => {
	let fixture: TestApp;
	let events: WsEvent[];

	beforeEach(async () => {
		fixture = await createTestApp();
		events = [];
		fixture.services.domain.events.subscribe(event => {
			events.push(event);
		});
	});

	afterEach(async () => {
		await fixture.close();
	});

	function post(body: unknown) {
		return fixture.app.request("/api/injection-rules", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function list() {
		return injectionRuleListResponseSchema.parse(
			await readJson<unknown>(await fixture.app.request("/api/injection-rules")),
		);
	}

	function injectionEvents(): Extract<WsEvent, { type: "injection.changed" }>[] {
		return events.filter(event => event.type === "injection.changed");
	}

	it("lists nothing on a fresh whaloc", async () => {
		expect(await list()).toEqual({ data: [] });
	});

	it("creates a rule, fully armed, and announces it", async () => {
		const response = await post({
			target: "messages.send",
			trigger: { kind: "next", count: 3 },
			preset: "rate_limit_429",
			retryAfterSeconds: 30,
			regainAccessMinutes: 5,
		});

		expect(response.status).toBe(201);

		const { data } = injectionRuleResponseSchema.parse(await readJson<unknown>(response));

		expect(data).toMatchObject({
			target: "messages.send",
			preset: "rate_limit_429",
			trigger: { kind: "next", count: 3 },
			retryAfterSeconds: 30,
			regainAccessMinutes: 5,
			seen: 0,
			matches: 0,
			remaining: 3,
			exhausted: false,
		});
		expect(injectionEvents()).toEqual([{ type: "injection.changed", payload: { rule: data, event: "created" } }]);
	});

	it("leaves `remaining` null for the triggers that do not count down", async () => {
		await post({ target: "graph.all", trigger: { kind: "always" }, preset: "server_error_500" });
		await post({ target: "graph.all", trigger: { kind: "every", nth: 4 }, preset: "server_error_500" });

		const { data } = await list();

		expect(data.map(rule => rule.remaining)).toEqual([null, null]);
		expect(data.every(rule => !rule.exhausted)).toBe(true);
	});

	it("keeps the listing in creation order, which is evaluation order", async () => {
		const created: string[] = [];

		for (const target of ["messages.send", "media.upload", "templates.list"] as const) {
			const { data } = injectionRuleResponseSchema.parse(
				await readJson<unknown>(await post({ target, trigger: { kind: "always" }, preset: "server_error_500" })),
			);

			created.push(data.id);
		}

		const listed = await list();

		expect(listed.data.map(rule => rule.id)).toEqual(created);
	});

	it("announces the counters a request moved, so the UI's countdown is live", async () => {
		await post({ target: "messages.send", trigger: { kind: "next", count: 2 }, preset: "server_error_500" });
		events.length = 0;

		await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", to: "5511912345678", type: "text", text: { body: "x" } }),
		});

		const announced = injectionEvents();

		expect(announced).toHaveLength(1);
		expect(announced[0]!.payload).toMatchObject({ event: "updated", rule: { seen: 1, matches: 1, remaining: 1 } });
	});

	it("deletes a rule, answering with the one that is gone", async () => {
		const { data } = injectionRuleResponseSchema.parse(
			await readJson<unknown>(
				await post({ target: "graph.all", trigger: { kind: "always" }, preset: "server_error_500" }),
			),
		);
		const response = await fixture.app.request(`/api/injection-rules/${data.id}`, { method: "DELETE" });

		const answered = injectionRuleResponseSchema.parse(await readJson<unknown>(response));
		const listed = await list();

		expect(response.status).toBe(200);
		expect(answered.data.id).toBe(data.id);
		expect(listed.data).toEqual([]);
		expect(injectionEvents().at(-1)?.payload.event).toBe("deleted");
	});

	it("reports an unknown rule as 404 in the control plane's own error shape", async () => {
		const response = await fixture.app.request("/api/injection-rules/nope", { method: "DELETE" });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { message: "no injection rule with id nope", code: "unknown_injection_rule" },
		});
	});

	it.each([
		["an unknown target", { target: "messages.sent", trigger: { kind: "always" }, preset: "server_error_500" }],
		["an unknown preset", { target: "graph.all", trigger: { kind: "always" }, preset: "explode" }],
		["a next trigger with no count", { target: "graph.all", trigger: { kind: "next" }, preset: "server_error_500" }],
		["a zero countdown", { target: "graph.all", trigger: { kind: "next", count: 0 }, preset: "server_error_500" }],
		[
			"a Retry-After that is not a number",
			{ target: "graph.all", trigger: { kind: "always" }, preset: "rate_limit_429", retryAfterSeconds: "soon" },
		],
	])("refuses %s", async (_name, body) => {
		expect(await statusOf(post(body))).toBe(400);
	});

	it("is wiped by POST /api/reset", async () => {
		await post({ target: "graph.all", trigger: { kind: "always" }, preset: "server_error_500" });
		await fixture.app.request("/api/reset", { method: "POST" });

		const listed = await list();

		expect(listed.data).toEqual([]);
	});
});
