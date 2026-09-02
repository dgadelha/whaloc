import { describe, expect, it } from "vitest";
import { formatSessionTime } from "./meta-errors.ts";
import { maskToken, tokenId } from "./token-registry.ts";

/**
 * The three pure pieces of the token registry (SPEC §1.9). Its behavior is covered end to end in
 * `graph-api/bearer-auth.spec.ts`; these are the details that are easier to pin down here.
 */

describe("tokenId", () => {
	it("is stable, so a UI's link to a token survives a restart", () => {
		expect(tokenId("EAAexample")).toBe(tokenId("EAAexample"));
	});

	it("does not contain the token", () => {
		expect(tokenId("EAAexample")).not.toContain("EAAexample");
		expect(tokenId("EAAexample")).toMatch(/^[\da-f]{16}$/);
	});

	it("tells two tokens apart, however similar", () => {
		expect(tokenId("EAAexample1")).not.toBe(tokenId("EAAexample2"));
	});
});

describe("maskToken", () => {
	it("keeps the last four characters and hides the rest", () => {
		expect(maskToken("EAAsecret-abcd")).toBe("••••••••••abcd");
	});

	it("caps the dots so one long token cannot stretch the UI", () => {
		expect(maskToken(`${"x".repeat(200)}abcd`)).toBe(`${"•".repeat(12)}abcd`);
	});

	it("hides a token too short to have a visible suffix", () => {
		expect(maskToken("abcd")).toBe("••••");
		expect(maskToken("ab")).toBe("••");
	});
});

describe("formatSessionTime", () => {
	it("prints Meta's expired-session shape, in UTC", () => {
		expect(formatSessionTime(new Date("2026-09-01T12:00:00.000Z"))).toBe("Tuesday, 01-Sep-26 12:00:00 UTC");
	});

	it("pads every field", () => {
		expect(formatSessionTime(new Date("2026-01-04T03:05:09.000Z"))).toBe("Sunday, 04-Jan-26 03:05:09 UTC");
	});

	it("does not drift with the host's time zone", () => {
		// A moment that is a different calendar day in most of the Americas.
		expect(formatSessionTime(new Date("2026-12-31T23:30:00.000Z"))).toBe("Thursday, 31-Dec-26 23:30:00 UTC");
	});
});
