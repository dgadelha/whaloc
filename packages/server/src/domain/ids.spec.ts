import { describe, expect, it } from "vitest";
import {
	createFbtraceId,
	createMediaId,
	createMediaUrlToken,
	createNumericId,
	createPhoneNumberId,
	createTemplateId,
	createWabaId,
	createWamid,
	createWebhookChallenge,
	defaultRandomBytes,
	createWebhookDeliveryId,
	deriveNumericId,
	FBTRACE_ID_PATTERN,
	META_ID_PATTERN,
	WAMID_PATTERN,
	type RandomBytes,
} from "./ids.ts";

/** Hands out the given bytes, so a generator's output can be pinned exactly. */
function fixedBytes(hex: string): RandomBytes {
	return () => Buffer.from(hex, "hex");
}

function times<T>(count: number, create: () => T): T[] {
	return Array.from({ length: count }, () => create());
}

/** How many of `count` generated ids came out unique. */
function uniqueCount(ids: string[]): number {
	const unique = new Set(ids);

	return unique.size;
}

describe("createWamid", () => {
	/**
	 * The vector is synthetic — a number nobody owns, with the random tail pinned — but the bytes
	 * around it are Meta's: reproduce this and a wamid whaloc mints is byte-shaped like a real one.
	 */
	it("matches the production wamid frame layout", () => {
		const wamid = createWamid("5511912345678", fixedBytes("634D372EB8C2CD7599"));

		expect(wamid).toBe("wamid.HBgNNTUxMTkxMjM0NTY3OBUCABEYEjYzNEQzNzJFQjhDMkNENzU5OQA=");
	});

	it("carries the recipient it was given", () => {
		const wamid = createWamid("15550000101");

		const decoded = Buffer.from(wamid.slice("wamid.".length), "base64");

		expect(decoded.toString("latin1")).toContain("15550000101");
	});

	it("looks like a wamid even without a recipient", () => {
		expect(createWamid("")).toMatch(WAMID_PATTERN);
	});

	it("accepts a business-scoped user id as the recipient", () => {
		expect(createWamid("BR.ENT.4KgQ2wJ8")).toMatch(WAMID_PATTERN);
	});

	it("never repeats itself", () => {
		const wamids = times(1000, () => createWamid("5511912345678"));

		expect(uniqueCount(wamids)).toBe(wamids.length);
	});

	it("refuses a recipient that does not fit the envelope", () => {
		expect(() => createWamid("9".repeat(256))).toThrow(RangeError);
	});
});

describe("createFbtraceId", () => {
	it("looks like the trace ids Meta returns", () => {
		expect(createFbtraceId()).toMatch(FBTRACE_ID_PATTERN);
		expect(createFbtraceId()).toHaveLength("AOnodi98JaYHcSTvVvrOtJs".length);
	});

	it("never repeats itself", () => {
		const ids = times(1000, () => createFbtraceId());

		expect(uniqueCount(ids)).toBe(ids.length);
	});
});

describe("createNumericId", () => {
	it.each([
		["WABA", createWabaId],
		["phone number", createPhoneNumberId],
		["media", createMediaId],
		["template", createTemplateId],
	])("generates a digit-only %s id the consumer accepts", (_name, create) => {
		const id = create();

		expect(id).toMatch(META_ID_PATTERN);
		expect(id).toHaveLength(15);
	});

	it("stays below 2^53 so template ids survive as JSON numbers", () => {
		const ids = times(200, () => createTemplateId());

		for (const id of ids) {
			expect(Number(id)).toBeLessThan(Number.MAX_SAFE_INTEGER);
			expect(String(Number(id))).toBe(id);
		}
	});

	it("never starts with a zero", () => {
		const allZeroBytes = fixedBytes("00".repeat(15));

		expect(createNumericId(allZeroBytes)).toMatch(/^[1-9]/);
	});

	it("keeps collisions out of a thousand ids", () => {
		const ids = times(1000, () => createMediaId());

		expect(uniqueCount(ids)).toBe(ids.length);
	});
});

describe("createMediaUrlToken", () => {
	it("is an unguessable URL-safe token", () => {
		const tokens = times(500, () => createMediaUrlToken());

		expect(createMediaUrlToken()).toMatch(/^[\w-]{32}$/);
		expect(uniqueCount(tokens)).toBe(tokens.length);
	});
});

describe("createWebhookDeliveryId", () => {
	it("is a hex string", () => {
		const ids = times(500, () => createWebhookDeliveryId());

		expect(createWebhookDeliveryId()).toMatch(/^[\da-f]{32}$/);
		expect(uniqueCount(ids)).toBe(ids.length);
	});

	it("sorts in the order the attempts were logged, ties included", () => {
		// The delivery log is read newest first and several attempts can share a millisecond.
		const sameMillisecond = times(50, () => createWebhookDeliveryId(defaultRandomBytes, 1_760_000_000_000));

		expect(sameMillisecond.toSorted((left, right) => left.localeCompare(right))).toEqual(sameMillisecond);
		expect(createWebhookDeliveryId(defaultRandomBytes, 1_760_000_000_001) > sameMillisecond.at(-1)!).toBe(true);
	});
});

describe("createWebhookChallenge", () => {
	it("is unguessable, and different every time", () => {
		const challenges = times(500, () => createWebhookChallenge());

		expect(createWebhookChallenge()).toMatch(/^[\da-f]{32}$/);
		expect(uniqueCount(challenges)).toBe(challenges.length);
	});
});

describe("deriveNumericId", () => {
	it("returns the same id for the same natural key", () => {
		expect(deriveNumericId("waba:whaloc Test Business")).toBe(deriveNumericId("waba:whaloc Test Business"));
	});

	it("returns a different id for a different key", () => {
		expect(deriveNumericId("waba:Acme")).not.toBe(deriveNumericId("waba:Other"));
	});

	it("looks exactly like a generated id", () => {
		const id = deriveNumericId("phone_number:1:5511912345678");

		expect(id).toMatch(META_ID_PATTERN);
		expect(id).toHaveLength(15);
		expect(Number(id)).toBeLessThan(Number.MAX_SAFE_INTEGER);
	});
});
