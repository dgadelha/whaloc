import type { InjectionRuleCreateRequest } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FBTRACE_ID_PATTERN } from "../domain/index.ts";
import { pathOf, readJson, statusOf, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";
import { classifyEndpoint } from "./injection.ts";

/**
 * Deterministic error injection (SPEC §4, "Error simulation").
 *
 * The envelopes and the two throttling headers are asserted byte for byte: they are the whole
 * contract the consumer parses (SPEC §1.11), and `estimated_time_to_regain_access` being in
 * **minutes** while `Retry-After` is in seconds is exactly the kind of thing a rewrite breaks.
 */

interface ErrorEnvelope {
	error: {
		message: string;
		type: string;
		code: number;
		error_subcode?: number;
		error_data?: { messaging_product: string; details: string };
		fbtrace_id: string;
	};
}

interface UsageEntry {
	type: string;
	call_count: number;
	total_cputime: number;
	total_time: number;
	estimated_time_to_regain_access: number;
}

describe("classifyEndpoint", () => {
	const shape = (method: string, path: string, hasPhoneNumberId = false) => ({ method, path, hasPhoneNumberId });

	it.each([
		["POST", "/v25.0/123/messages", "messages.send"],
		["POST", "/v25.0/123/media", "media.upload"],
		["POST", "/v25.0/123/message_templates", "templates.create"],
		["GET", "/v25.0/123/message_templates", "templates.list"],
		["GET", "/whaloc-media/abc", "media.download"],
	])("classifies %s %s as %s", (method, path, target) => {
		expect(classifyEndpoint(shape(method, path))).toBe(target);
	});

	it("classifies the descriptor hop only when phone_number_id is present", () => {
		expect(classifyEndpoint(shape("GET", "/v25.0/123", true))).toBe("media.resolve");
		expect(classifyEndpoint(shape("GET", "/v25.0/123"))).toBeNull();
	});

	it("answers null for a Graph request in no class of its own", () => {
		expect(classifyEndpoint(shape("GET", "/v25.0/123/phone_numbers"))).toBeNull();
		expect(classifyEndpoint(shape("POST", "/v25.0/123/register"))).toBeNull();
		expect(classifyEndpoint(shape("DELETE", "/v25.0/123/message_templates"))).toBeNull();
	});

	it("does not care which version prefix the caller used (SPEC §1.1)", () => {
		expect(classifyEndpoint(shape("POST", "/v99.9/123/messages"))).toBe("messages.send");
		expect(classifyEndpoint(shape("POST", "/123/messages"))).toBe("messages.send");
	});
});

describe("error injection", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	async function armRule(rule: InjectionRuleCreateRequest): Promise<{ id: string }> {
		const response = await fixture.app.request("/api/injection-rules", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(rule),
		});

		expect(response.status).toBe(201);

		const { data } = await readJson<{ data: { id: string } }>(response);

		return data;
	}

	function send() {
		return fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to: "5511912345678",
				type: "text",
				text: { body: "hello" },
			}),
		});
	}

	function readPhoneNumber() {
		return fixture.app.request(`/v25.0/${fixture.phoneNumberId}`, { headers: TEST_AUTH_HEADERS });
	}

	function usageHeader(response: Response): Record<string, UsageEntry[]> {
		return JSON.parse(response.headers.get("x-business-use-case-usage") ?? "null") as Record<string, UsageEntry[]>;
	}

	describe("presets", () => {
		it("rate_limit_429: 429, code 130429, Retry-After and the usage header (SPEC §1.11)", async () => {
			await armRule({
				target: "messages.send",
				trigger: { kind: "always" },
				preset: "rate_limit_429",
				retryAfterSeconds: 42,
				regainAccessMinutes: 7,
			});

			const response = await send();

			expect(response.status).toBe(429);
			expect(await response.json()).toEqual({
				error: {
					message: "(#130429) Rate limit hit",
					type: "OAuthException",
					code: 130_429,
					error_data: {
						messaging_product: "whatsapp",
						details: "Cloud API message throughput has been reached.",
					},
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
			// Delta-seconds, which is one of the two forms the consumer parses.
			expect(response.headers.get("retry-after")).toBe("42");
			expect(usageHeader(response)).toEqual({
				[fixture.wabaId]: [
					{
						type: "whatsapp",
						call_count: 100,
						total_cputime: 100,
						total_time: 100,
						// Minutes, not seconds — the one unit mismatch that would silently break a backoff.
						estimated_time_to_regain_access: 7,
					},
				],
			});
		});

		it("rate_limit_429 falls back to 60 s / 15 min when the rule says nothing", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "always" }, preset: "rate_limit_429" });

			const response = await send();

			expect(response.headers.get("retry-after")).toBe("60");
			expect(usageHeader(response)[fixture.wabaId]![0]!.estimated_time_to_regain_access).toBe(15);
		});

		it("throughput_131056: 400, code 131056, no throttling headers", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "always" }, preset: "throughput_131056" });

			const response = await send();

			expect(response.status).toBe(400);
			expect(await readJson<ErrorEnvelope>(response)).toEqual({
				error: {
					message: "(#131056) (Business Account, Consumer account) pair rate limit hit",
					type: "OAuthException",
					code: 131_056,
					error_data: {
						messaging_product: "whatsapp",
						details: stringMatching(/^Too many messages sent from this phone number/),
					},
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
			expect(response.headers.get("retry-after")).toBeNull();
			expect(response.headers.get("x-business-use-case-usage")).toBeNull();
		});

		it("spam_rate_4: 429, code 4, the throttling headers, no subcode", async () => {
			await armRule({
				target: "messages.send",
				trigger: { kind: "always" },
				preset: "spam_rate_4",
				retryAfterSeconds: 300,
				regainAccessMinutes: 60,
			});

			const response = await send();

			expect(response.status).toBe(429);
			expect(await response.json()).toEqual({
				error: {
					message: "(#4) Application request limit reached",
					type: "OAuthException",
					code: 4,
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
			expect(response.headers.get("retry-after")).toBe("300");
			expect(usageHeader(response)[fixture.wabaId]![0]!.estimated_time_to_regain_access).toBe(60);
		});

		it("server_error_500: 500, code 1, nothing else", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "always" }, preset: "server_error_500" });

			const response = await send();

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: {
					message: "An unknown error occurred",
					type: "OAuthException",
					code: 1,
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
		});

		it("custom: the caller writes the envelope", async () => {
			await armRule({
				target: "messages.send",
				trigger: { kind: "always" },
				preset: "custom",
				custom: {
					httpStatus: 400,
					code: 131_047,
					subcode: 2_494_010,
					message: "(#131047) Re-engagement message",
					details: "More than 24 hours have passed since the recipient last replied.",
					type: "GraphMethodException",
				},
			});

			const response = await send();

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: {
					message: "(#131047) Re-engagement message",
					type: "GraphMethodException",
					code: 131_047,
					error_subcode: 2_494_010,
					error_data: {
						messaging_product: "whatsapp",
						details: "More than 24 hours have passed since the recipient last replied.",
					},
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
		});

		it("refuses a custom rule with no envelope, and a preset rule with one", async () => {
			const naked = await fixture.app.request("/api/injection-rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target: "graph.all", trigger: { kind: "always" }, preset: "custom" }),
			});
			const dressed = await fixture.app.request("/api/injection-rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					target: "graph.all",
					trigger: { kind: "always" },
					preset: "server_error_500",
					custom: { httpStatus: 400, code: 1, message: "nope" },
				}),
			});

			expect(naked.status).toBe(400);
			expect(dressed.status).toBe(400);
		});
	});

	describe("triggers", () => {
		it("next N fails exactly N times, then recovers", async () => {
			const rule = await armRule({
				target: "messages.send",
				trigger: { kind: "next", count: 3 },
				preset: "rate_limit_429",
			});
			const statuses: number[] = [];

			for (let attempt = 0; attempt < 5; attempt += 1) {
				statuses.push(await statusOf(send()));
			}

			expect(statuses).toEqual([429, 429, 429, 200, 200]);

			const { data } = await readJson<{ data: { remaining: number; exhausted: boolean; matches: number }[] }>(
				await fixture.app.request("/api/injection-rules"),
			);

			expect(data[0]).toMatchObject({ remaining: 0, exhausted: true, matches: 3 });
			expect(rule.id).toBeTruthy();
		});

		it("counts the countdown down one request at a time", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "next", count: 2 }, preset: "server_error_500" });

			const remaining = async (): Promise<number | null> => {
				const { data } = await readJson<{ data: { remaining: number | null }[] }>(
					await fixture.app.request("/api/injection-rules"),
				);

				return data[0]!.remaining;
			};

			expect(await remaining()).toBe(2);
			await send();
			expect(await remaining()).toBe(1);
			await send();
			expect(await remaining()).toBe(0);
		});

		it("every Nth fails on the Nth request, deterministically", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "every", nth: 3 }, preset: "server_error_500" });

			const statuses: number[] = [];

			for (let attempt = 0; attempt < 7; attempt += 1) {
				statuses.push(await statusOf(send()));
			}

			expect(statuses).toEqual([200, 200, 500, 200, 200, 500, 200]);
		});

		it("counts only the requests its own target matches", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "every", nth: 2 }, preset: "server_error_500" });

			// Reads of the phone number are not sends, so they must not move the cadence.
			await readPhoneNumber();
			await readPhoneNumber();

			expect(await statusOf(send())).toBe(200);
			expect(await statusOf(send())).toBe(500);
		});

		it("always fires on every matching request", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "always" }, preset: "server_error_500" });

			expect(await statusOf(send())).toBe(500);
			expect(await statusOf(send())).toBe(500);
			// A different endpoint class is untouched.
			expect(await statusOf(readPhoneNumber())).toBe(200);
		});
	});

	describe("targets", () => {
		it("graph.all catches everything, the media byte endpoint included", async () => {
			const upload = new FormData();

			upload.set("file", new File([new Uint8Array([1, 2, 3])], "a.bin", { type: "image/png" }));

			const uploaded = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/media`, {
				method: "POST",
				headers: TEST_AUTH_HEADERS,
				body: upload,
			});
			const { id } = await readJson<{ id: string }>(uploaded);
			const descriptor = await fixture.app.request(`/v25.0/${id}?phone_number_id=${fixture.phoneNumberId}`, {
				headers: TEST_AUTH_HEADERS,
			});
			const { url } = await readJson<{ url: string }>(descriptor);

			await armRule({ target: "graph.all", trigger: { kind: "always" }, preset: "server_error_500" });

			expect(await statusOf(send())).toBe(500);
			expect(await statusOf(readPhoneNumber())).toBe(500);

			// The byte endpoint is outside the bearer gate but inside the injection middleware, and
			// an injected failure is Meta-shaped wherever it lands.
			const bytes = await fixture.app.request(pathOf(url));

			const envelope = await readJson<ErrorEnvelope>(bytes);

			expect(bytes.status).toBe(500);
			expect(envelope.error.code).toBe(1);
		});

		it.each([
			["media.upload", "POST", "/media"],
			["templates.create", "POST", "/message_templates"],
			["templates.list", "GET", "/message_templates"],
		])("targets %s and nothing else", async (target, method, suffix) => {
			await armRule({
				target: target as InjectionRuleCreateRequest["target"],
				trigger: { kind: "always" },
				preset: "server_error_500",
			});

			const owner = target === "media.upload" ? fixture.phoneNumberId : fixture.wabaId;
			const response = await fixture.app.request(`/v25.0/${owner}${suffix}`, {
				method,
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				...(method === "POST" && { body: JSON.stringify({}) }),
			});

			expect(response.status).toBe(500);
			expect(await statusOf(send())).toBe(200);
		});

		it("targets media.resolve without touching the byte endpoint", async () => {
			const upload = new FormData();

			upload.set("file", new File([new Uint8Array([1, 2, 3])], "a.bin", { type: "image/png" }));

			const uploaded = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/media`, {
				method: "POST",
				headers: TEST_AUTH_HEADERS,
				body: upload,
			});
			const { id } = await readJson<{ id: string }>(uploaded);
			const before = await fixture.app.request(`/v25.0/${id}?phone_number_id=${fixture.phoneNumberId}`, {
				headers: TEST_AUTH_HEADERS,
			});
			const { url } = await readJson<{ url: string }>(before);

			await armRule({ target: "media.resolve", trigger: { kind: "always" }, preset: "server_error_500" });

			const resolved = await fixture.app.request(`/v25.0/${id}?phone_number_id=${fixture.phoneNumberId}`, {
				headers: TEST_AUTH_HEADERS,
			});

			const bytePath = pathOf(url);

			expect(resolved.status).toBe(500);
			expect(await statusOf(fixture.app.request(bytePath))).toBe(200);
		});
	});

	describe("precedence", () => {
		it("never hides a 401: authentication runs first", async () => {
			await armRule({ target: "graph.all", trigger: { kind: "always" }, preset: "rate_limit_429" });

			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}`);

			const envelope = await readJson<ErrorEnvelope>(response);

			expect(response.status).toBe(401);
			expect(envelope.error.code).toBe(190);
		});

		it("answers with the first rule that fires, in creation order", async () => {
			await armRule({ target: "messages.send", trigger: { kind: "every", nth: 2 }, preset: "throughput_131056" });
			await armRule({ target: "graph.all", trigger: { kind: "always" }, preset: "server_error_500" });

			// The `every 2` rule has not come around yet, so the `graph.all` rule answers.
			expect(await statusOf(send())).toBe(500);
			// Second request: the earlier rule fires and wins.
			expect(await statusOf(send())).toBe(400);
		});

		it("leaves a shadowed countdown intact", async () => {
			await armRule({ target: "graph.all", trigger: { kind: "always" }, preset: "server_error_500" });
			await armRule({ target: "messages.send", trigger: { kind: "next", count: 2 }, preset: "rate_limit_429" });

			await send();
			await send();

			const { data } = await readJson<{ data: { remaining: number | null; seen: number }[] }>(
				await fixture.app.request("/api/injection-rules"),
			);

			// It saw both requests, but it never fired, so it is still fully armed.
			expect(data[1]).toMatchObject({ remaining: 2, seen: 2 });
		});
	});

	describe("bookkeeping", () => {
		it("leaves an unarmed whaloc alone", async () => {
			expect(await statusOf(send())).toBe(200);
			expect(await statusOf(readPhoneNumber())).toBe(200);
		});

		it("stops injecting once the rule is deleted", async () => {
			const rule = await armRule({ target: "messages.send", trigger: { kind: "always" }, preset: "server_error_500" });

			expect(await statusOf(send())).toBe(500);

			const deleted = await fixture.app.request(`/api/injection-rules/${rule.id}`, { method: "DELETE" });

			expect(deleted.status).toBe(200);
			expect(await statusOf(send())).toBe(200);
		});

		it("is cleared by POST /api/reset", async () => {
			await armRule({ target: "graph.all", trigger: { kind: "always" }, preset: "server_error_500" });
			await fixture.app.request("/api/reset", { method: "POST" });

			const { data } = await readJson<{ data: unknown[] }>(await fixture.app.request("/api/injection-rules"));

			expect(data).toEqual([]);
			expect(await statusOf(readPhoneNumber())).toBe(200);
		});
	});
});
