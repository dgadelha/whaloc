import { describe, expect, it } from "vitest";
import { toWaId } from "./message-service.ts";
import { messagePayloadOf, sendMessageRequestSchema, SEND_MESSAGE_TYPES } from "./send-message-request.ts";

function parse(request: Record<string, unknown>) {
	return sendMessageRequestSchema.safeParse({ messaging_product: "whatsapp", to: "5511912345678", ...request });
}

describe("sendMessageRequestSchema", () => {
	it("covers exactly the eleven documented types (SPEC §2.5)", () => {
		expect(SEND_MESSAGE_TYPES).toHaveLength(11);

		for (const type of SEND_MESSAGE_TYPES) {
			expect(parse({ type }).success).toBe(false);
		}

		expect(parse({ type: "carrier_pigeon" }).success).toBe(false);
	});

	it("defaults a body without a type to text", () => {
		const result = parse({ text: { body: "Hi" } });

		expect(result.success && result.data.type).toBe("text");
	});

	it("drops unknown top-level keys the way Meta does", () => {
		const result = parse({ type: "text", text: { body: "Hi" }, recipient_type: "individual", biz_opaque: "x" });

		expect(result.success && result.data).not.toHaveProperty("recipient_type");
	});

	it.each([
		["id", { id: "1234567890" }],
		["link", { link: "https://example.com/photo.jpg" }],
		["both", { id: "1234567890", link: "https://example.com/photo.jpg" }],
	])("accepts a media node addressed by %s", (_label, image) => {
		expect(parse({ type: "image", image }).success).toBe(true);
	});

	it("rejects a media node with neither id nor link", () => {
		expect(parse({ type: "image", image: { caption: "orphan" } }).success).toBe(false);
	});

	it("accepts coordinates as numbers or strings", () => {
		expect(parse({ type: "location", location: { latitude: 37.4847, longitude: -122.1486 } }).success).toBe(true);
		expect(parse({ type: "location", location: { latitude: "37.4847", longitude: "-122.1486" } }).success).toBe(true);
	});

	it("accepts an empty emoji, which is how a reaction is removed", () => {
		expect(parse({ type: "reaction", reaction: { message_id: "wamid.A", emoji: "" } }).success).toBe(true);
	});

	it("passes interactive and contacts payloads through unchecked", () => {
		expect(parse({ type: "interactive", interactive: { anything: true } }).success).toBe(true);
		expect(parse({ type: "contacts", contacts: [{ anything: true }] }).success).toBe(true);
		expect(parse({ type: "contacts", contacts: [] }).success).toBe(false);
	});

	it("requires messaging_product to be whatsapp, with Meta's wording", () => {
		const result = sendMessageRequestSchema.safeParse({
			messaging_product: "sms",
			to: "5511912345678",
			type: "text",
			text: { body: "Hi" },
		});

		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toBe("Param messaging_product must be whatsapp");
	});

	it("takes the recipient from either to or recipient (SPEC §1.15)", () => {
		const body = { messaging_product: "whatsapp", type: "text", text: { body: "Hi" } };

		expect(sendMessageRequestSchema.safeParse({ ...body, to: "5511912345678" }).success).toBe(true);
		expect(sendMessageRequestSchema.safeParse({ ...body, recipient: "BR.ENT.4KgQ2wJ8" }).success).toBe(true);
		expect(sendMessageRequestSchema.safeParse(body).success).toBe(false);
	});
});

describe("messagePayloadOf", () => {
	it("keys the stored payload by the message type", () => {
		const result = parse({ type: "image", image: { id: "1234567890", caption: "A photo" } });

		expect(result.success && messagePayloadOf(result.data)).toEqual({
			image: { id: "1234567890", caption: "A photo" },
		});
	});

	it("keeps an array payload an array", () => {
		const result = parse({ type: "contacts", contacts: [{ name: { formatted_name: "John" } }] });

		expect(result.success && messagePayloadOf(result.data)).toEqual({
			contacts: [{ name: { formatted_name: "John" } }],
		});
	});
});

describe("toWaId", () => {
	it.each([
		["5511912345678", "5511912345678"],
		["+55 11 91234-5678", "5511912345678"],
		["+1 (650) 555-1234", "16505551234"],
	])("strips the formatting of %o", (input, expected) => {
		expect(toWaId(input)).toBe(expected);
	});

	it.each(["BR.ENT.4KgQ2wJ8", "US.4KgQ2wJ8"])("leaves the business-scoped id %o alone", input => {
		expect(toWaId(input)).toBe(input);
	});
});
