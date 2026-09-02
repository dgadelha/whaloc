import type { InboundRequest, WsEvent } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomainHarness, HARNESS_PUBLIC_URL, type DomainHarness } from "../testing/domain-harness.ts";
import { stringMatching } from "../testing/expectations.ts";
import { InboundService } from "./inbound-service.ts";
import { WAMID_PATTERN } from "./ids.ts";
import { WebhookEmitter } from "./webhook-emitter.ts";

/**
 * Simulating the user side (SPEC §5). The webhook the app under test would receive is read
 * back off the delivery log, so these tests assert on the payload and not just on the row.
 */
describe("InboundService", () => {
	let harness: DomainHarness;
	let events: WsEvent[];
	let inbound: InboundService;

	beforeEach(async () => {
		harness = await createDomainHarness();
		events = [];

		const publish = (event: WsEvent): void => {
			events.push(event);
		};

		inbound = new InboundService({
			repositories: harness.repositories,
			webhooks: new WebhookEmitter({
				repositories: harness.repositories,
				logger: harness.logger,
				target: {},
				events: { publish },
			}),
			tasks: harness.tasks,
			media: harness.media,
			events: { publish },
		});
	});

	afterEach(async () => {
		await harness.close();
	});

	/**
	 * The body of one inbound branch. It is deliberately loose here — the discriminated union
	 * is validated at the route (`control-routes.spec.ts` goes through the real schema); these
	 * tests are about what the service does with a request that already parsed.
	 */
	type InboundBody = Record<string, unknown> & { type: InboundRequest["type"] };

	function request(overrides: InboundBody): InboundRequest {
		return {
			phoneNumberId: harness.phoneNumberId,
			from: harness.contactWaId,
			...overrides,
		} as InboundRequest;
	}

	/** The `messages[0]` node of the last webhook logged. */
	async function lastMessageNode(): Promise<Record<string, unknown>> {
		await harness.tasks.whenIdle();

		const [delivery] = await harness.repositories.webhookDeliveries.list({ limit: 1 });
		const body = JSON.parse(delivery!.requestBody) as {
			entry: [{ changes: [{ value: { messages: [Record<string, unknown>]; contacts: unknown } }] }];
		};

		return body.entry[0].changes[0].value.messages[0];
	}

	async function uploadMedia(mimeType = "image/jpeg") {
		return harness.repositories.media.insert({
			id: "1234567890",
			phoneNumberId: harness.phoneNumberId,
			mimeType,
			sha256: "lRvdoYJL5FRnY+B5y93Lp5NH/7oXdzR+4sCKs+vUT/0=",
			fileSize: 1024,
			storageKey: "abc",
			urlToken: "token",
		});
	}

	it("stores a text message and emits the webhook Meta would have sent", async () => {
		const message = await inbound.simulate(request({ type: "text", text: { body: "Does it come in blue?" } }));

		expect(message).toMatchObject({
			direction: "inbound",
			status: "delivered",
			type: "text",
			payload: { text: { body: "Does it come in blue?" } },
			contactWaId: harness.contactWaId,
		});
		expect(message.id).toMatch(WAMID_PATTERN);
		expect(await lastMessageNode()).toEqual({
			from: harness.contactWaId,
			id: message.id,
			timestamp: stringMatching(/^\d+$/),
			type: "text",
			text: { body: "Does it come in blue?" },
		});
	});

	it("announces the message on the event bus", async () => {
		const message = await inbound.simulate(request({ type: "text", text: { body: "Hi" } }));

		expect(events[0]).toMatchObject({ type: "message.created", payload: { message: { id: message.id } } });
	});

	it("resolves a media id to the metadata the app will download with", async () => {
		const media = await uploadMedia();

		await inbound.simulate(request({ type: "image", media: { id: media.id, caption: "Is this the one?" } }));

		expect(await lastMessageNode()).toMatchObject({
			type: "image",
			image: { id: media.id, mime_type: "image/jpeg", sha256: media.sha256, caption: "Is this the one?" },
		});
	});

	/**
	 * Meta ships a `url` on every media node now, so a consumer can download in one hop instead
	 * of resolving the id first. Both paths have to land on the same bytes.
	 */
	it("carries the byte url a consumer can fetch straight away", async () => {
		const media = await uploadMedia();

		await inbound.simulate(request({ type: "image", media: { id: media.id } }));

		const node = (await lastMessageNode()) as { image: { url: string } };

		expect(node.image.url).toBe(`${HARNESS_PUBLIC_URL}/whaloc-media/${media.urlToken}`);
		// The same URL the descriptor hop hands out — one place mints them.
		expect(node.image.url).toBe(harness.media.descriptor(media).url);
	});

	it("reports the media hash base64-encoded, the way Meta writes it", async () => {
		const media = await uploadMedia();

		await inbound.simulate(request({ type: "image", media: { id: media.id } }));

		const node = (await lastMessageNode()) as { image: { sha256: string } };

		expect(Buffer.from(node.image.sha256, "base64")).toHaveLength(32);
	});

	it("keeps the filename of a document", async () => {
		const media = await uploadMedia("application/pdf");

		await inbound.simulate(request({ type: "document", media: { id: media.id, filename: "invoice.pdf" } }));

		expect(await lastMessageNode()).toMatchObject({ document: { filename: "invoice.pdf" } });
	});

	/**
	 * Meta puts `voice` on every audio node and `animated` on every sticker node — never on the
	 * other three — so a consumer reads them without checking whether the key is there.
	 */
	it("always says whether an audio node is a voice recording", async () => {
		const media = await uploadMedia("audio/ogg");

		await inbound.simulate(request({ type: "audio", media: { id: media.id } }));

		expect(await lastMessageNode()).toMatchObject({ audio: { voice: false } });

		await inbound.simulate(request({ type: "audio", media: { id: media.id, voice: true } }));

		expect(await lastMessageNode()).toMatchObject({ audio: { voice: true } });
	});

	it("always says whether a sticker is animated", async () => {
		const media = await uploadMedia("image/webp");

		await inbound.simulate(request({ type: "sticker", media: { id: media.id } }));

		expect(await lastMessageNode()).toMatchObject({ sticker: { animated: false } });

		await inbound.simulate(request({ type: "sticker", media: { id: media.id, animated: true } }));

		expect(await lastMessageNode()).toMatchObject({ sticker: { animated: true } });
	});

	it("keeps voice and animated off the media types Meta never puts them on", async () => {
		const media = await uploadMedia();

		await inbound.simulate(request({ type: "image", media: { id: media.id, voice: true, animated: true } }));

		const node = (await lastMessageNode()) as { image: Record<string, unknown> };

		expect(node.image).not.toHaveProperty("voice");
		expect(node.image).not.toHaveProperty("animated");
	});

	/** Meta omits `emoji` entirely when a user takes their reaction back (reaction reference). */
	it("omits the emoji of a withdrawn reaction rather than sending an empty one", async () => {
		await inbound.simulate(request({ type: "reaction", reaction: { message_id: "wamid.OUTBOUND", emoji: "" } }));

		const node = (await lastMessageNode()) as { reaction: Record<string, unknown> };

		expect(node.reaction).toEqual({ message_id: "wamid.OUTBOUND" });
		expect(node.reaction).not.toHaveProperty("emoji");
	});

	it("refuses a media id that resolves to nothing", async () => {
		await expect(inbound.simulate(request({ type: "image", media: { id: "999" } }))).rejects.toThrow(/no media object/);
	});

	it("refuses media belonging to another phone number", async () => {
		const media = await uploadMedia();

		await harness.repositories.phoneNumbers.insert({
			id: "555000111222333",
			wabaId: harness.wabaId,
			displayPhoneNumber: "+1 555 000-1111",
			verifiedName: "Other",
		});

		await expect(
			inbound.simulate(request({ type: "image", media: { id: media.id }, phoneNumberId: "555000111222333" })),
		).rejects.toThrow(/another phone number/);
	});

	it.each([
		[
			"an interactive button reply",
			{ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes" } } },
			{ interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes" } } },
		],
		[
			"an interactive list reply",
			{
				type: "interactive",
				interactive: { type: "list_reply", list_reply: { id: "sku-1", title: "Blue", description: "In stock" } },
			},
			{ interactive: { type: "list_reply", list_reply: { id: "sku-1", title: "Blue", description: "In stock" } } },
		],
		[
			"a template quick-reply button",
			{ type: "button", button: { payload: "STOP", text: "Stop promotions" } },
			{ button: { payload: "STOP", text: "Stop promotions" } },
		],
		[
			"a location",
			{ type: "location", location: { latitude: -12.97, longitude: -38.5, name: "Salvador" } },
			{ location: { latitude: -12.97, longitude: -38.5, name: "Salvador" } },
		],
		[
			// Meta sends `url` for a business location; a dropped pin carries none.
			"a business location with its url",
			{
				type: "location",
				location: {
					latitude: 37.44221496582,
					longitude: -122.16165924072,
					name: "Philz Coffee",
					address: "101 Forest Ave, Palo Alto, CA 94301",
					url: "https://philzcoffee.com/",
				},
			},
			{
				location: {
					latitude: 37.44221496582,
					longitude: -122.16165924072,
					name: "Philz Coffee",
					address: "101 Forest Ave, Palo Alto, CA 94301",
					url: "https://philzcoffee.com/",
				},
			},
		],
		[
			"a contact card",
			{ type: "contacts", contacts: [{ name: { formatted_name: "Ana Souza" } }] },
			{ contacts: [{ name: { formatted_name: "Ana Souza" } }] },
		],
		[
			"a reaction",
			{ type: "reaction", reaction: { message_id: "wamid.OUTBOUND", emoji: "👍" } },
			{ reaction: { message_id: "wamid.OUTBOUND", emoji: "👍" } },
		],
	] as [string, InboundBody, Record<string, unknown>][])("stores %s", async (_name, payload, expected) => {
		const message = await inbound.simulate(request(payload));

		expect(message.payload).toEqual(expected);
		expect(await lastMessageNode()).toMatchObject({ type: payload.type, ...expected });
	});

	it("quotes the outbound message a reply answers", async () => {
		await inbound.simulate(request({ type: "text", text: { body: "Yes please" }, replyTo: "wamid.OUTBOUND" }));

		expect(await lastMessageNode()).toMatchObject({
			context: { from: "15550783881", id: "wamid.OUTBOUND" },
		});
	});

	it("creates a contact on first sight and announces it", async () => {
		await inbound.simulate(request({ type: "text", text: { body: "Hi" }, from: "5599999999999" }));

		const contact = await harness.repositories.contacts.findByWaId("5599999999999");

		expect(contact).toMatchObject({ waId: "5599999999999", profileName: "5599999999999" });
		expect(events[0]).toMatchObject({ type: "contact.changed" });
	});

	it("renames a contact whose profile name changed", async () => {
		await inbound.simulate(request({ type: "text", text: { body: "Hi" }, profileName: "Sheena N." }));

		expect(await harness.repositories.contacts.findByWaId(harness.contactWaId)).toMatchObject({
			profileName: "Sheena N.",
		});
		expect(events.filter(event => event.type === "contact.changed")).toHaveLength(1);
	});

	it("refuses an unknown phone number", async () => {
		await expect(
			inbound.simulate(request({ type: "text", text: { body: "Hi" }, phoneNumberId: "404404404404404" })),
		).rejects.toThrow(/no phone number/);
	});

	it("honors an explicit timestamp", async () => {
		const timestamp = "2026-01-02T03:04:05.000Z";
		const message = await inbound.simulate(request({ type: "text", text: { body: "Hi" }, timestamp }));

		const seconds = Math.floor(Date.parse(timestamp) / 1000);

		expect(message.timestamp).toBe(timestamp);
		expect(await lastMessageNode()).toMatchObject({ timestamp: String(seconds) });
	});

	/** The context riders (SPEC §5): where each one lands, and what it does to the stored row. */
	describe("context riders", () => {
		const REFERRAL = {
			source_url: "https://fb.me/2Ax9kLm",
			source_type: "ad",
			source_id: "120210000000000000",
			headline: "Autumn sale",
			media_type: "image",
			ctwa_clid: "ARAxYzc1",
		};

		it("puts a referral top-level on the message and stores it on the row", async () => {
			const message = await inbound.simulate(request({ type: "text", text: { body: "Hi" }, referral: REFERRAL }));

			expect(message.payload["referral"]).toEqual(REFERRAL);
			expect(await lastMessageNode()).toMatchObject({ type: "text", referral: REFERRAL });
		});

		/**
		 * The ad's greeting arrives as a nested object, not a bare string — it is how a handler
		 * tells an ad-generated opener from something the person actually typed.
		 */
		it("carries the ad's welcome_message as the nested object Meta sends", async () => {
			const referral = { ...REFERRAL, welcome_message: { text: "Hi there! Let us know how we can help!" } };

			await inbound.simulate(request({ type: "text", text: { body: "Hi" }, referral }));

			expect(await lastMessageNode()).toMatchObject({
				referral: { welcome_message: { text: "Hi there! Let us know how we can help!" } },
			});
		});

		it("puts forwarded and frequently_forwarded inside context, on any type", async () => {
			await inbound.simulate(
				request({
					type: "location",
					location: { latitude: -12.97, longitude: -38.5 },
					forwarded: true,
					frequentlyForwarded: true,
				}),
			);

			expect(await lastMessageNode()).toMatchObject({
				type: "location",
				context: { forwarded: true, frequently_forwarded: true },
			});
		});

		it("puts referred_product inside context, next to the reply quote when there is one", async () => {
			await inbound.simulate(
				request({
					type: "text",
					text: { body: "Is this in stock?" },
					replyTo: "wamid.OUTBOUND",
					forwarded: true,
					referredProduct: { catalog_id: "1234567", product_retailer_id: "SKU-9" },
				}),
			);

			const node = await lastMessageNode();

			expect(node["context"]).toEqual({
				from: "15550783881",
				id: "wamid.OUTBOUND",
				forwarded: true,
				referred_product: { catalog_id: "1234567", product_retailer_id: "SKU-9" },
			});
		});

		it("leaves context off entirely when nothing asked for one", async () => {
			await inbound.simulate(request({ type: "text", text: { body: "Hi" } }));

			expect(await lastMessageNode()).not.toHaveProperty("context");
		});
	});

	/** Meta's placeholder for a message this API version cannot represent (SPEC §5). */
	describe("unsupported messages", () => {
		it("stores a row so the chat shows a placeholder, and emits Meta's 131051 node", async () => {
			const message = await inbound.simulate(request({ type: "unsupported" }));

			expect(message.type).toBe("unsupported");
			expect(message.status).toBe("delivered");
			expect(await lastMessageNode()).toEqual({
				from: harness.contactWaId,
				id: message.id,
				timestamp: expect.any(String) as string,
				type: "unsupported",
				errors: [
					{
						code: 131_051,
						title: "Message type unknown",
						message: "Message type unknown",
						error_data: { details: "Message type is currently not supported." },
					},
				],
				// Meta always names the type it could not represent, alongside the error.
				unsupported: { type: "poll_update" },
			});
		});

		it("names the unsupported type the caller asked for", async () => {
			await inbound.simulate(request({ type: "unsupported", unsupportedType: "order" }));

			expect(await lastMessageNode()).toMatchObject({ type: "unsupported", unsupported: { type: "order" } });
		});

		it("takes the riders like every other type", async () => {
			await inbound.simulate(request({ type: "unsupported", forwarded: true }));

			expect(await lastMessageNode()).toMatchObject({ type: "unsupported", context: { forwarded: true } });
		});
	});
});
