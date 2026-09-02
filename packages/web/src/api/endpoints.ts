import {
	contactListResponseSchema,
	contactResponseSchema,
	conversationListResponseSchema,
	conversationMessagesResponseSchema,
	handshakeResponseSchema,
	importResponseSchema,
	inboundMediaResponseSchema,
	inboundResponseSchema,
	injectionRuleListResponseSchema,
	injectionRuleResponseSchema,
	mediaResponseSchema,
	messageErrorPresetListResponseSchema,
	messageResponseSchema,
	phoneNumberResponseSchema,
	resetResponseSchema,
	stateResponseSchema,
	templateListResponseSchema,
	templateResponseSchema,
	tokenListResponseSchema,
	typingIndicatorListResponseSchema,
	tokenResponseSchema,
	uploadResponseSchema,
	wabaResponseSchema,
	webhookDeliveryAttemptsResponseSchema,
	webhookDeliveryListResponseSchema,
	type AccountUpdateRequest,
	type BusinessCapabilityUpdateRequest,
	type BusinessProfileUpdateRequest,
	type Contact,
	type ContactCreateRequest,
	type ContactNumberChangeRequest,
	type ContactUpdateRequest,
	type Conversation,
	type ConversationMessagesResponse,
	type HandshakeResult,
	type ImportResponse,
	type InboundRequest,
	type InjectionRule,
	type InjectionRuleCreateRequest,
	type JsonObject,
	type ListTemplatesQuery,
	type MediaDescriptor,
	type Message,
	type MessageErrorPreset,
	type MessageStatusRequest,
	type PhoneNumber,
	type PhoneNumberCreateRequest,
	type PhoneNumberQualityRequest,
	type PhoneNumberUpdateRequest,
	type QualityRating,
	type RejectTemplateRequest,
	type StateResponse,
	type Template,
	type TokenListResponse,
	type TokenState,
	type TypingIndicator,
	type UploadDescriptor,
	type Waba,
	type WabaCreateRequest,
	type WebhookDelivery,
	type WebhookDeliveryListResponse,
} from "@whaloc/shared";
import { z } from "zod";
import { queryString, request } from "./client.ts";

/**
 * Every control-plane route the UI uses, in one place (SPEC §5). The names mirror the routes;
 * the schemas are the shared ones, so these functions return exactly what the server promised.
 */

export interface Signal {
	signal?: AbortSignal | undefined;
}

const emptySchema = z.unknown();

export const api = {
	getState: async (options: Signal = {}): Promise<StateResponse> =>
		request("/api/state", { schema: stateResponseSchema, ...options }),

	async reset(): Promise<StateResponse> {
		const { data } = await request("/api/reset", { method: "POST", schema: resetResponseSchema });

		return data;
	},

	/**
	 * `POST /api/import` — replaces every piece of state with the snapshot in `file` (SPEC §5).
	 *
	 * The export is not here on purpose: `GET /api/export` answers with an attachment, so the UI
	 * links straight at {@link EXPORT_PATH} and lets the browser save it, rather than pulling a
	 * whole snapshot through `fetch` only to hand it back as a blob.
	 */
	async importState(file: File): Promise<ImportResponse["data"]> {
		const form = new FormData();

		form.set("file", file);

		const { data } = await request("/api/import", { method: "POST", form, schema: importResponseSchema });

		return data;
	},

	async listContacts(options: Signal = {}): Promise<Contact[]> {
		const { data } = await request("/api/contacts", { schema: contactListResponseSchema, ...options });

		return data;
	},

	async createContact(body: ContactCreateRequest): Promise<Contact> {
		const { data } = await request("/api/contacts", { method: "POST", body, schema: contactResponseSchema });

		return data;
	},

	/** The profile name and the BSUID (SPEC §1.15); `userId: null` clears the BSUID. */
	async updateContact(waId: string, body: ContactUpdateRequest): Promise<Contact> {
		const { data } = await request(`/api/contacts/${encodeURIComponent(waId)}`, {
			method: "PATCH",
			body,
			schema: contactResponseSchema,
		});

		return data;
	},

	/** The person moved: the contact follows, and Meta's `user_changed_number` goes out (SPEC §5). */
	async changeContactNumber(waId: string, body: ContactNumberChangeRequest): Promise<Contact> {
		const { data } = await request(`/api/contacts/${encodeURIComponent(waId)}/change-number`, {
			method: "POST",
			body,
			schema: contactResponseSchema,
		});

		return data;
	},

	async listConversations(phoneNumberId: string | undefined, options: Signal = {}): Promise<Conversation[]> {
		const { data } = await request(`/api/conversations${queryString({ phoneNumberId })}`, {
			schema: conversationListResponseSchema,
			...options,
		});

		return data;
	},

	listMessages: async (
		conversationId: string,
		page: { limit?: number; before?: string } = {},
		options: Signal = {},
	): Promise<ConversationMessagesResponse> => {
		return request(`/api/conversations/${encodeURIComponent(conversationId)}/messages${queryString({ ...page })}`, {
			schema: conversationMessagesResponseSchema,
			...options,
		});
	},

	async sendInbound(body: InboundRequest): Promise<Message> {
		const { data } = await request("/api/inbound", { method: "POST", body, schema: inboundResponseSchema });

		return data;
	},

	async uploadInboundMedia(phoneNumberId: string, file: File): Promise<{ id: string; mimeType: string }> {
		const form = new FormData();

		form.set("phoneNumberId", phoneNumberId);
		form.set("file", file);

		if (file.type !== "") {
			form.set("type", file.type);
		}

		const { data } = await request("/api/inbound-media", {
			method: "POST",
			form,
			schema: inboundMediaResponseSchema,
		});

		return data;
	},

	async getMedia(id: string, options: Signal = {}): Promise<MediaDescriptor> {
		const { data } = await request(`/api/media/${encodeURIComponent(id)}`, {
			schema: mediaResponseSchema,
			...options,
		});

		return data;
	},

	/**
	 * The upload behind a resumable-upload handle (SPEC §2.21), so a template's media header can
	 * be previewed with the picture it will actually send.
	 */
	async getUpload(handle: string, options: Signal = {}): Promise<UploadDescriptor> {
		const { data } = await request(`/api/uploads${queryString({ handle })}`, {
			schema: uploadResponseSchema,
			...options,
		});

		return data;
	},

	async setMessageStatus(id: string, body: MessageStatusRequest): Promise<Message> {
		const { data } = await request(`/api/messages/${encodeURIComponent(id)}/status`, {
			method: "POST",
			body,
			schema: messageResponseSchema,
		});

		return data;
	},

	async listMessageErrorPresets(options: Signal = {}): Promise<MessageErrorPreset[]> {
		const { data } = await request("/api/message-error-presets", {
			schema: messageErrorPresetListResponseSchema,
			...options,
		});

		return data;
	},

	/** The typing indicators that are up right now (SPEC §2.18) — the UI's socket keeps them current. */
	async listTyping(phoneNumberId: string | undefined, options: Signal = {}): Promise<TypingIndicator[]> {
		const { data } = await request(`/api/typing${queryString({ phoneNumberId })}`, {
			schema: typingIndicatorListResponseSchema,
			...options,
		});

		return data;
	},

	/** Filters are applied server-side, the same ones the Graph listing takes (SPEC §2.8). */
	async listTemplates(query: ListTemplatesQuery = {}, options: Signal = {}): Promise<Template[]> {
		const { data } = await request(`/api/templates${queryString({ ...query })}`, {
			schema: templateListResponseSchema,
			...options,
		});

		return data;
	},

	approveTemplate: async (id: string): Promise<Template> => templateAction(id, "approve"),

	rejectTemplate: async (id: string, body: RejectTemplateRequest): Promise<Template> =>
		templateAction(id, "reject", body),

	pauseTemplate: async (id: string): Promise<Template> => templateAction(id, "pause"),

	disableTemplate: async (id: string): Promise<Template> => templateAction(id, "disable"),

	setTemplateQuality: async (id: string, qualityScore: QualityRating): Promise<Template> =>
		templateAction(id, "quality", { qualityScore }),

	listWebhookDeliveries: async (
		page: { limit?: number; before?: string } = {},
		options: Signal = {},
	): Promise<WebhookDeliveryListResponse> => {
		return request(`/api/webhook-deliveries${queryString({ ...page })}`, {
			schema: webhookDeliveryListResponseSchema,
			...options,
		});
	},

	async redeliverWebhook(id: string): Promise<WebhookDelivery[]> {
		const { data } = await request(`/api/webhook-deliveries/${encodeURIComponent(id)}/redeliver`, {
			method: "POST",
			schema: webhookDeliveryAttemptsResponseSchema,
		});

		return data;
	},

	async runHandshake(): Promise<HandshakeResult> {
		const { data } = await request("/api/webhook/handshake", { method: "POST", schema: handshakeResponseSchema });

		return data;
	},

	async sendRawWebhook(payload: JsonObject): Promise<WebhookDelivery[]> {
		const { data } = await request("/api/webhook/raw", {
			method: "POST",
			body: payload,
			schema: webhookDeliveryAttemptsResponseSchema,
		});

		return data;
	},

	/**
	 * The two account-level webhooks (SPEC §3). Both are emissions only — nothing in whaloc
	 * changes — so they answer with the delivery attempts rather than with any state.
	 */
	async sendAccountUpdate(body: AccountUpdateRequest): Promise<WebhookDelivery[]> {
		const { data } = await request("/api/webhook/account-update", {
			method: "POST",
			body,
			schema: webhookDeliveryAttemptsResponseSchema,
		});

		return data;
	},

	async sendBusinessCapabilityUpdate(body: BusinessCapabilityUpdateRequest): Promise<WebhookDelivery[]> {
		const { data } = await request("/api/webhook/business-capability-update", {
			method: "POST",
			body,
			schema: webhookDeliveryAttemptsResponseSchema,
		});

		return data;
	},

	/** The business profile a phone number publishes (SPEC §2.19); a blank field clears it. */
	async updateBusinessProfile(id: string, body: BusinessProfileUpdateRequest): Promise<PhoneNumber> {
		const { data } = await request(`/api/phone-numbers/${encodeURIComponent(id)}/business-profile`, {
			method: "POST",
			body,
			schema: phoneNumberResponseSchema,
		});

		return data;
	},

	async setPhoneNumberQuality(id: string, body: PhoneNumberQualityRequest): Promise<PhoneNumber> {
		const { data } = await request(`/api/phone-numbers/${encodeURIComponent(id)}/quality`, {
			method: "POST",
			body,
			schema: phoneNumberResponseSchema,
		});

		return data;
	},

	async createWaba(body: WabaCreateRequest): Promise<Waba> {
		const { data } = await request("/api/wabas", { method: "POST", body, schema: wabaResponseSchema });

		return data;
	},

	async renameWaba(id: string, name: string): Promise<Waba> {
		const { data } = await request(`/api/wabas/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: { name },
			schema: wabaResponseSchema,
		});

		return data;
	},

	/** Answers with the WABA that is gone, so the caller can name it in a toast. */
	async deleteWaba(id: string): Promise<Waba> {
		const { data } = await request(`/api/wabas/${encodeURIComponent(id)}`, {
			method: "DELETE",
			schema: wabaResponseSchema,
		});

		return data;
	},

	async createPhoneNumber(body: PhoneNumberCreateRequest): Promise<PhoneNumber> {
		const { data } = await request("/api/phone-numbers", { method: "POST", body, schema: phoneNumberResponseSchema });

		return data;
	},

	async updatePhoneNumber(id: string, body: PhoneNumberUpdateRequest): Promise<PhoneNumber> {
		const { data } = await request(`/api/phone-numbers/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body,
			schema: phoneNumberResponseSchema,
		});

		return data;
	},

	async deletePhoneNumber(id: string): Promise<PhoneNumber> {
		const { data } = await request(`/api/phone-numbers/${encodeURIComponent(id)}`, {
			method: "DELETE",
			schema: phoneNumberResponseSchema,
		});

		return data;
	},

	/** The armed error-injection rules (SPEC §4); loaded at bootstrap, so the shell can warn. */
	async listInjectionRules(options: Signal = {}): Promise<InjectionRule[]> {
		const { data } = await request("/api/injection-rules", { schema: injectionRuleListResponseSchema, ...options });

		return data;
	},

	async createInjectionRule(body: InjectionRuleCreateRequest): Promise<InjectionRule> {
		const { data } = await request("/api/injection-rules", {
			method: "POST",
			body,
			schema: injectionRuleResponseSchema,
		});

		return data;
	},

	/** Answers with the rule that is gone, so the caller can name it in a toast. */
	async deleteInjectionRule(id: string): Promise<InjectionRule> {
		const { data } = await request(`/api/injection-rules/${encodeURIComponent(id)}`, {
			method: "DELETE",
			schema: injectionRuleResponseSchema,
		});

		return data;
	},

	/** The registry `WHALOC_TOKENS` configures; `strict:false` means there is none (SPEC §1.9). */
	listTokens: async (options: Signal = {}): Promise<TokenListResponse> =>
		request("/api/tokens", { schema: tokenListResponseSchema, ...options }),

	async setTokenExpired(id: string, isExpired: boolean): Promise<TokenState> {
		const { data } = await request(`/api/tokens/${encodeURIComponent(id)}/${isExpired ? "expire" : "restore"}`, {
			method: "POST",
			schema: tokenResponseSchema,
		});

		return data;
	},

	/** Only used to prove the server is up before the first render; the body is irrelevant. */
	async ping(options: Signal = {}): Promise<void> {
		await request("/api/health", { schema: emptySchema, ...options });
	},
};

async function templateAction(id: string, action: string, body?: unknown): Promise<Template> {
	const { data } = await request(`/api/templates/${encodeURIComponent(id)}/${action}`, {
		method: "POST",
		schema: templateResponseSchema,
		...(body !== undefined && { body }),
	});

	return data;
}
