import { healthResponseSchema } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./testing/test-app.ts";

describe("createApp", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	it.each(["/health", "/api/health"])("answers the health check on %s", async path => {
		const response = await fixture.app.request(path);

		expect(response.status).toBe(200);
		expect(healthResponseSchema.parse(await response.json())).toMatchObject({ status: "ok" });
	});

	it("tags responses with a request id", async () => {
		const response = await fixture.app.request("/health");

		expect(response.headers.get("x-request-id")).toEqual(expect.any(String));
	});

	it("keeps the request id sent by the caller", async () => {
		const response = await fixture.app.request("/health", { headers: { "x-request-id": "abc-123" } });

		expect(response.headers.get("x-request-id")).toBe("abc-123");
	});

	it("does not answer unknown paths", async () => {
		const response = await fixture.app.request("/nope");

		expect(response.status).toBe(404);
	});
});
