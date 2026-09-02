import { describe, expect, it } from "vitest";
import { CONTACT_WA_ID, PHONE_NUMBER_ID } from "../../test/factories.ts";
import {
	buildInboundRequest,
	emptyDraft,
	emptyExtras,
	hasExtras,
	type ComposerContext,
	type ComposerDraft,
	type ComposerExtras,
} from "./composer-payload.ts";

const context: ComposerContext = { phoneNumberId: PHONE_NUMBER_ID, from: CONTACT_WA_ID };

function build(draft: ComposerDraft, overrides: Partial<ComposerContext> = {}) {
	return buildInboundRequest({ ...context, ...overrides }, draft);
}

/** Every branch of `POST /api/inbound`, asserted on the exact body that would go out. */
describe("buildInboundRequest", () => {
	it("builds a text message", () => {
		const result = build({ kind: "text", body: "  hello there  " });

		expect(result).toEqual({
			ok: true,
			request: { phoneNumberId: PHONE_NUMBER_ID, from: CONTACT_WA_ID, type: "text", text: { body: "hello there" } },
		});
	});

	it("carries the reply context when one is set", () => {
		const result = build({ kind: "text", body: "sure" }, { replyTo: "wamid.abc" });

		expect(result).toMatchObject({ ok: true, request: { replyTo: "wamid.abc" } });
	});

	it("refuses an empty text", () => {
		expect(build({ kind: "text", body: " ".repeat(3) })).toMatchObject({ ok: false });
	});

	it("builds a media message with the optional fields it was given", () => {
		const result = build({
			kind: "media",
			mediaType: "image",
			mediaId: "123456",
			caption: "Look",
			filename: "",
		});

		expect(result).toEqual({
			ok: true,
			request: {
				phoneNumberId: PHONE_NUMBER_ID,
				from: CONTACT_WA_ID,
				type: "image",
				media: { id: "123456", caption: "Look" },
			},
		});
	});

	it("keeps the filename on a document", () => {
		const result = build({
			kind: "media",
			mediaType: "document",
			mediaId: "42",
			caption: "",
			filename: "invoice.pdf",
		});

		expect(result).toMatchObject({
			ok: true,
			request: { type: "document", media: { id: "42", filename: "invoice.pdf" } },
		});
	});

	it("refuses a media message with no upload behind it", () => {
		expect(build({ kind: "media", mediaType: "image", mediaId: "", caption: "", filename: "" })).toMatchObject({
			ok: false,
		});
	});

	it("builds a location, parsing the coordinates as numbers", () => {
		const result = build({
			kind: "location",
			latitude: "-12.9777",
			longitude: "-38.5016",
			name: "Elevador Lacerda",
			address: "Salvador, BA",
		});

		expect(result).toEqual({
			ok: true,
			request: {
				phoneNumberId: PHONE_NUMBER_ID,
				from: CONTACT_WA_ID,
				type: "location",
				location: {
					latitude: -12.9777,
					longitude: -38.5016,
					name: "Elevador Lacerda",
					address: "Salvador, BA",
				},
			},
		});
	});

	it("reports coordinates that are not numbers", () => {
		const result = build({ kind: "location", latitude: "north", longitude: "-38.5", name: "", address: "" });

		expect(result).toEqual({ ok: false, error: "latitude and longitude must be numbers" });
	});

	it("builds a reaction, and never quotes anything", () => {
		const result = build({ kind: "reaction", messageId: "wamid.abc", emoji: "👍" }, { replyTo: "wamid.other" });

		expect(result).toEqual({
			ok: true,
			request: {
				phoneNumberId: PHONE_NUMBER_ID,
				from: CONTACT_WA_ID,
				type: "reaction",
				reaction: { message_id: "wamid.abc", emoji: "👍" },
			},
		});
	});

	it("allows an empty emoji, which is how Meta removes a reaction", () => {
		expect(build({ kind: "reaction", messageId: "wamid.abc", emoji: "" })).toMatchObject({
			ok: true,
			request: { reaction: { emoji: "" } },
		});
	});

	it("builds a button_reply", () => {
		const result = build({
			kind: "interactive",
			replyType: "button_reply",
			id: "confirm",
			title: "Confirm",
			description: "ignored for buttons",
		});

		expect(result).toEqual({
			ok: true,
			request: {
				phoneNumberId: PHONE_NUMBER_ID,
				from: CONTACT_WA_ID,
				type: "interactive",
				interactive: { type: "button_reply", button_reply: { id: "confirm", title: "Confirm" } },
			},
		});
	});

	it("builds a list_reply with its description", () => {
		const result = build({
			kind: "interactive",
			replyType: "list_reply",
			id: "row-1",
			title: "Small",
			description: "12cm",
		});

		expect(result).toMatchObject({
			ok: true,
			request: {
				interactive: { type: "list_reply", list_reply: { id: "row-1", title: "Small", description: "12cm" } },
			},
		});
	});

	it("builds a template quick-reply button", () => {
		const result = build({ kind: "button", payload: "STOP", text: "Stop promotions" });

		expect(result).toMatchObject({
			ok: true,
			request: { type: "button", button: { payload: "STOP", text: "Stop promotions" } },
		});
	});

	it("builds contact cards from the JSON editor", () => {
		const result = build({ kind: "contacts", json: emptyContactsJson() });

		expect(result).toMatchObject({
			ok: true,
			request: { type: "contacts", contacts: [{ name: { formatted_name: "Ada Lovelace" } }] },
		});
	});

	it("wraps a single card, which is the shape people paste", () => {
		const result = build({ kind: "contacts", json: '{"name":{"formatted_name":"Ada"}}' });

		expect(result).toMatchObject({ ok: true, request: { contacts: [{ name: { formatted_name: "Ada" } }] } });
	});

	it("reports invalid JSON in the contacts editor", () => {
		const result = build({ kind: "contacts", json: "{oops" });

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.error).toContain("contacts must be valid JSON");
	});
});

/**
 * The context riders (SPEC §5): whaloc's camelCase on the outside, Meta's snake_case inside the
 * nodes it will echo verbatim, and nothing at all when the panel is untouched.
 */
describe("context riders", () => {
	function withExtras(patch: (extras: ComposerExtras) => void) {
		const extras = emptyExtras();

		patch(extras);

		return buildInboundRequest(context, { kind: "text", body: "hi" }, extras);
	}

	it("adds nothing to a draft nobody touched", () => {
		expect(build({ kind: "text", body: "hi" })).toEqual({
			ok: true,
			request: { phoneNumberId: PHONE_NUMBER_ID, from: CONTACT_WA_ID, type: "text", text: { body: "hi" } },
		});
		expect(hasExtras(emptyExtras())).toBe(false);
	});

	it("sends the two forwarding flags only when they are on", () => {
		expect(
			withExtras(extras => {
				extras.forwarded = true;
			}),
		).toMatchObject({ ok: true, request: { forwarded: true } });

		const both = withExtras(extras => {
			extras.forwarded = true;
			extras.frequentlyForwarded = true;
		});

		expect(both).toMatchObject({ ok: true, request: { forwarded: true, frequentlyForwarded: true } });
		expect(both.ok && "referral" in both.request).toBe(false);
	});

	it("drops the referral fields left blank, and keeps media_type only when picked", () => {
		const result = withExtras(extras => {
			extras.referral.enabled = true;
			extras.referral.sourceUrl = " https://fb.me/2Ax9kLm ";
			extras.referral.sourceId = "120210000000000000";
			extras.referral.ctwaClid = "ARAxYzc1";
		});

		expect(result).toMatchObject({
			ok: true,
			request: {
				referral: {
					source_url: "https://fb.me/2Ax9kLm",
					source_type: "ad",
					source_id: "120210000000000000",
					ctwa_clid: "ARAxYzc1",
				},
			},
		});
		expect(result.ok && "media_type" in (result.request as { referral: object }).referral).toBe(false);
	});

	it("sends a referred product in Meta's shape", () => {
		expect(
			withExtras(extras => {
				extras.referredProduct.enabled = true;
				extras.referredProduct.catalogId = "1234567";
				extras.referredProduct.productRetailerId = "SKU-9";
			}),
		).toMatchObject({
			ok: true,
			request: { referredProduct: { catalog_id: "1234567", product_retailer_id: "SKU-9" } },
		});
	});

	it("rides on a reaction too, which is the one branch built without the reply context", () => {
		const extras = emptyExtras();

		extras.forwarded = true;

		expect(
			buildInboundRequest(context, { kind: "reaction", messageId: "wamid.target", emoji: "👍" }, extras),
		).toMatchObject({ ok: true, request: { type: "reaction", forwarded: true } });
	});

	it("counts as set as soon as one rider is on", () => {
		const extras = emptyExtras();

		extras.referral.enabled = true;

		expect(hasExtras(extras)).toBe(true);
	});
});

describe("emptyDraft", () => {
	it("starts every mode on something the form can render", () => {
		for (const kind of [
			"text",
			"media",
			"location",
			"reaction",
			"interactive",
			"button",
			"contacts",
			"unsupported",
		] as const) {
			expect(emptyDraft(kind).kind).toBe(kind);
		}
	});
});

function emptyContactsJson(): string {
	const draft = emptyDraft("contacts");

	return draft.kind === "contacts" ? draft.json : "";
}
