import { DEFAULT_UNSUPPORTED_MESSAGE_TYPE, type InboundMediaType, type InboundRequest } from "@whaloc/shared";
import type { ContactRecord, JsonObject, MessageRecord, Repositories } from "../db/index.ts";
import type { BackgroundTasks } from "./background-tasks.ts";
import { toContactDto, toMessageDto } from "./control-dto.ts";
import { controlBadRequest, controlNotFound } from "./control-plane-error.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createWamid, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import type { MediaService } from "./media-service.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";
import {
	inboundMessageValue,
	unsupportedMessageErrorNode,
	unsupportedMessageNode,
	webhookEnvelope,
	WEBHOOK_FIELDS,
} from "./webhook-payloads.ts";

/**
 * Simulating the user side of a conversation (`POST /api/inbound`, SPEC §5).
 *
 * One method covers every inbound type. The payload it stores is the *exact* type-named node
 * Meta puts in the webhook — media nodes resolved to their `mime_type` and `sha256`, an
 * interactive reply nested under its own `type` — so the emitter can spread it into the
 * payload without a second translation step.
 *
 * Inbound messages are recorded as `delivered`: they arrived by definition, and no status
 * ladder ever runs for them (Meta reports statuses for outbound messages only).
 */

export interface InboundServiceOptions {
	repositories: Repositories;
	webhooks: WebhookEmitter;
	tasks: BackgroundTasks;
	/** Builds the byte URL an inbound media node carries; the one place media URLs are minted. */
	media: MediaService;
	events?: EventPublisher;
	scheduler?: Scheduler;
	random?: RandomBytes;
}

/**
 * The context riders a request may carry, as the `context` node Meta puts them in (SPEC §5).
 *
 * They are stored *without* the reply quote: `replyTo` already lives in its own column, and
 * `inboundMessageValue` merges the two when the webhook goes out — so a forwarded reply is one
 * `context` with `from`, `id` and `forwarded` in it, which is what Meta sends.
 */
function contextRiders(request: InboundRequest): JsonObject | undefined {
	const riders: JsonObject = {
		...(request.forwarded === true && { forwarded: true }),
		...(request.frequentlyForwarded === true && { frequently_forwarded: true }),
		...(request.referredProduct !== undefined && { referred_product: request.referredProduct }),
	};

	return Object.keys(riders).length === 0 ? undefined : riders;
}

export class InboundService {
	readonly #repositories: Repositories;
	readonly #webhooks: WebhookEmitter;
	readonly #tasks: BackgroundTasks;
	readonly #media: MediaService;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #random: RandomBytes;

	constructor(options: InboundServiceOptions) {
		this.#repositories = options.repositories;
		this.#webhooks = options.webhooks;
		this.#tasks = options.tasks;
		this.#media = options.media;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#random = options.random ?? defaultRandomBytes;
	}

	/**
	 * The contact the message is from: created on first sight, renamed when the request
	 * carries a different profile name — which is what happens when a real user edits theirs.
	 */
	async #resolveContact(waId: string, profileName?: string): Promise<ContactRecord> {
		const existing = await this.#repositories.contacts.findByWaId(waId);

		if (existing === null) {
			const created = await this.#repositories.contacts.insert({ waId, profileName: profileName ?? waId });

			this.#events.publish({ type: "contact.changed", payload: { contact: toContactDto(created) } });

			return created;
		}

		if (profileName === undefined || profileName === existing.profileName) {
			return existing;
		}

		const renamed = (await this.#repositories.contacts.update(waId, { profileName })) ?? existing;

		this.#events.publish({ type: "contact.changed", payload: { contact: toContactDto(renamed) } });

		return renamed;
	}

	/**
	 * The media node Meta sends: the id the app will download with, the `url` it can fetch
	 * straight away, and the metadata whaloc measured while storing the bytes. The media has to
	 * exist — a webhook pointing at a media id that resolves to nothing is exactly the bug this
	 * emulator is meant to catch.
	 *
	 * `url` is the same byte URL the descriptor hop hands out, so both of Meta's download paths
	 * lead to the same place: a consumer can `GET` it directly with its bearer token, or resolve
	 * the id first and get an identical URL back.
	 */
	async #mediaNode(request: Extract<InboundRequest, { type: InboundMediaType }>): Promise<JsonObject> {
		const media = await this.#repositories.media.findById(request.media.id);

		if (media === null) {
			throw controlNotFound(`no media object with id ${request.media.id}`, "unknown_media");
		}

		if (media.phoneNumberId !== request.phoneNumberId) {
			throw controlNotFound(`media ${request.media.id} belongs to another phone number`, "unknown_media");
		}

		return {
			id: media.id,
			mime_type: media.mimeType,
			sha256: media.sha256,
			url: this.#media.descriptor(media).url,
			...(request.media.caption !== undefined && { caption: request.media.caption }),
			...(request.media.filename !== undefined && { filename: request.media.filename }),
			// Two flags Meta puts on **every** node of their type, so whaloc does too: an audio
			// node always says whether it was a voice recording, a sticker always says whether it
			// is animated. Both are scoped to their own type — Meta sends neither on an image.
			...(request.type === "audio" && { voice: request.media.voice ?? false }),
			...(request.type === "sticker" && { animated: request.media.animated ?? false }),
		};
	}

	/** `{[type]: node}` plus the riders — the shape the message row stores and the webhook echoes. */
	async #payloadOf(request: InboundRequest): Promise<JsonObject> {
		const node = await this.#typeNodeOf(request);
		const context = contextRiders(request);

		return {
			...node,
			...(context !== undefined && { context }),
			// `referral` rides top-level on the message, unlike `referred_product` (SPEC §5).
			...(request.referral !== undefined && { referral: request.referral }),
		};
	}

	/** The type-named node alone. */
	async #typeNodeOf(request: InboundRequest): Promise<JsonObject> {
		switch (request.type) {
			case "image":
			case "video":
			case "audio":
			case "document":
			case "sticker": {
				return { [request.type]: await this.#mediaNode(request) };
			}
			case "text": {
				return { text: { body: request.text.body } };
			}
			case "interactive": {
				return { interactive: request.interactive };
			}
			case "button": {
				return { button: request.button };
			}
			case "location": {
				return { location: request.location };
			}
			case "contacts": {
				return { contacts: request.contacts };
			}
			case "reaction": {
				// Removing a reaction is Meta's *absent* `emoji`, not an empty one: the reference
				// says the key is omitted entirely from the payload, and a consumer that tests for
				// the key rather than its truthiness has to see the same thing whaloc's UI shows.
				const { emoji, ...rest } = request.reaction;

				return { reaction: { ...rest, ...(emoji !== "" && { emoji }) } };
			}
			case "unsupported": {
				// Meta describes an unrepresentable message with an `errors[]` entry (131051) *and*
				// an `unsupported` node naming the type it could not represent (SPEC §5). Both are
				// spread next to `type: "unsupported"` by the builder.
				return {
					errors: [unsupportedMessageErrorNode()],
					unsupported: unsupportedMessageNode(request.unsupportedType ?? DEFAULT_UNSUPPORTED_MESSAGE_TYPE),
				};
			}
			default: {
				// Unreachable while the shared schema and this switch agree; a new inbound type
				// added to `@whaloc/shared` lands here instead of being stored half-built.
				throw controlBadRequest("unsupported inbound message type", "unsupported_type");
			}
		}
	}

	/** Persists an inbound message, announces it, and emits the webhook Meta would have sent. */
	async simulate(request: InboundRequest): Promise<MessageRecord> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(request.phoneNumberId);

		if (phoneNumber === null) {
			throw controlNotFound(`no phone number with id ${request.phoneNumberId}`, "unknown_phone_number");
		}

		const contact = await this.#resolveContact(request.from, request.profileName);
		const payload = await this.#payloadOf(request);
		const timestamp = request.timestamp ?? this.#scheduler.now().toISOString();
		const message = await this.#repositories.messages.insert({
			id: createWamid(contact.waId, this.#random),
			direction: "inbound",
			phoneNumberId: phoneNumber.id,
			contactWaId: contact.waId,
			type: request.type,
			payload,
			status: "delivered",
			replyTo: request.replyTo ?? null,
			timestamp,
		});

		this.#events.publish({ type: "message.created", payload: { message: toMessageDto(message) } });

		this.#tasks.run(async () => {
			const value = inboundMessageValue({ phoneNumber, contact, message });

			await this.#webhooks.emit(
				WEBHOOK_FIELDS.messages,
				webhookEnvelope({ wabaId: phoneNumber.wabaId, field: WEBHOOK_FIELDS.messages, value }),
			);
		});

		return message;
	}
}
