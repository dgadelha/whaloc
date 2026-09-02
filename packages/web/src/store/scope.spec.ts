import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeStateResponse,
	makeTwoWabaState,
	PHONE_NUMBER_ID,
	SECOND_PHONE_NUMBER_ID,
	SECOND_WABA_ID,
	WABA_ID,
} from "../test/factories.ts";
import { pathFor, readLastScope, resolveScope, viewOf, writeLastScope } from "./scope.ts";

/**
 * The arithmetic of scope (SPEC §5). It is pure on purpose: the router repairs the URL with it
 * and the reducer heals the store with it, and the two agreeing is what keeps a deleted number
 * from bouncing the UI between two "valid" answers.
 */

describe("resolveScope", () => {
	it("has nothing to resolve to before the state has loaded", () => {
		expect(resolveScope(null, { wabaId: WABA_ID })).toEqual({ wabaId: null, phoneNumberId: null });
	});

	it("keeps a scope that exists", () => {
		expect(resolveScope(makeTwoWabaState(), { wabaId: SECOND_WABA_ID, phoneNumberId: SECOND_PHONE_NUMBER_ID })).toEqual(
			{
				wabaId: SECOND_WABA_ID,
				phoneNumberId: SECOND_PHONE_NUMBER_ID,
			},
		);
	});

	it("defaults to the first WABA that has a number, not simply the first", () => {
		expect(resolveScope(makeTwoWabaState({ firstHasNumbers: false }), {})).toEqual({
			wabaId: SECOND_WABA_ID,
			phoneNumberId: SECOND_PHONE_NUMBER_ID,
		});
	});

	it("keeps an empty WABA that was asked for by name", () => {
		expect(resolveScope(makeTwoWabaState({ firstHasNumbers: false }), { wabaId: WABA_ID })).toEqual({
			wabaId: WABA_ID,
			phoneNumberId: null,
		});
	});

	it("falls back to the first number of a WABA whose number is gone", () => {
		expect(resolveScope(makeTwoWabaState(), { wabaId: WABA_ID, phoneNumberId: "999999999999999" })).toEqual({
			wabaId: WABA_ID,
			phoneNumberId: PHONE_NUMBER_ID,
		});
	});

	it("moves to another WABA when the one named is gone", () => {
		expect(resolveScope(makeTwoWabaState(), { wabaId: "999999999999999" })).toEqual({
			wabaId: WABA_ID,
			phoneNumberId: PHONE_NUMBER_ID,
		});
	});

	// A URL that names the right number under the wrong account is repaired, not thrown away:
	// the number is the more specific intent, and it knows which account it belongs to.
	it("follows the number when the path pairs it with another account", () => {
		expect(resolveScope(makeTwoWabaState(), { wabaId: WABA_ID, phoneNumberId: SECOND_PHONE_NUMBER_ID })).toEqual({
			wabaId: SECOND_WABA_ID,
			phoneNumberId: SECOND_PHONE_NUMBER_ID,
		});
	});

	it("has no scope at all when every WABA is gone", () => {
		expect(resolveScope(makeStateResponse({ wabas: [] }), { wabaId: WABA_ID })).toEqual({
			wabaId: null,
			phoneNumberId: null,
		});
	});
});

describe("pathFor", () => {
	const scope = { wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID };

	it("puts both segments in a chats path", () => {
		expect(pathFor("chats", scope)).toBe(`/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats`);
	});

	it("adds the contact when one is open", () => {
		expect(pathFor("chats", scope, "5511912345678")).toBe(`/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats/5511912345678`);
	});

	it("stops at the account for the account-scoped view", () => {
		expect(pathFor("templates", scope)).toBe(`/w/${WABA_ID}/templates`);
	});

	it("drops the number segment for a WABA that has none", () => {
		expect(pathFor("chats", { wabaId: WABA_ID, phoneNumberId: null })).toBe(`/w/${WABA_ID}/chats`);
	});

	it("carries no scope at all into the global views", () => {
		expect(pathFor("webhooks", { wabaId: null, phoneNumberId: null })).toBe("/webhooks");
		expect(pathFor("settings", { wabaId: null, phoneNumberId: null })).toBe("/settings");
	});

	// Which is what disables the tab: there is nowhere for a scoped view to point.
	it("has no path for a scoped view without a WABA", () => {
		expect(pathFor("chats", { wabaId: null, phoneNumberId: null })).toBeNull();
		expect(pathFor("templates", { wabaId: null, phoneNumberId: null })).toBeNull();
	});
});

describe("viewOf", () => {
	it("reads the view out of a scoped path", () => {
		expect(viewOf(`/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats`)).toBe("chats");
		expect(viewOf(`/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats/5511912345678`)).toBe("chats");
		expect(viewOf(`/w/${WABA_ID}/templates`)).toBe("templates");
	});

	it("reads the global ones", () => {
		expect(viewOf("/webhooks")).toBe("webhooks");
		expect(viewOf("/settings")).toBe("settings");
	});

	it("treats anything else as the landing view", () => {
		expect(viewOf("/")).toBe("chats");
		expect(viewOf("/nonsense")).toBe("chats");
	});
});

describe("the last scope", () => {
	afterEach(() => {
		globalThis.localStorage.clear();
	});

	it("round-trips through storage", () => {
		writeLastScope({ wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID });

		expect(readLastScope()).toEqual({ wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID });
	});

	it("has no opinion before anything was stored", () => {
		expect(readLastScope()).toEqual({ wabaId: null, phoneNumberId: null });
	});

	it("ignores a stored value that is not a scope", () => {
		globalThis.localStorage.setItem("whaloc:last-scope", "{{{");

		expect(readLastScope()).toEqual({ wabaId: null, phoneNumberId: null });
	});

	// A browser that refuses to remember (private mode, blocked storage) must not stop the UI.
	it("survives a storage that throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});

		expect(readLastScope()).toEqual({ wabaId: null, phoneNumberId: null });
		expect(() => {
			writeLastScope({ wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID });
		}).not.toThrow();
	});
});
