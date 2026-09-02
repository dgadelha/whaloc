import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./health.ts";

describe("healthResponseSchema", () => {
	it("accepts a well-formed health response", () => {
		const result = healthResponseSchema.safeParse({
			status: "ok",
			uptimeSeconds: 12,
			timestamp: "2026-08-31T12:00:00.000Z",
		});

		expect(result.success).toBe(true);
	});

	it("rejects a non-ISO timestamp", () => {
		const result = healthResponseSchema.safeParse({
			status: "ok",
			uptimeSeconds: 12,
			timestamp: "yesterday",
		});

		expect(result.success).toBe(false);
	});

	it("rejects a fractional uptime", () => {
		const result = healthResponseSchema.safeParse({
			status: "ok",
			uptimeSeconds: 1.5,
			timestamp: "2026-08-31T12:00:00.000Z",
		});

		expect(result.success).toBe(false);
	});
});
