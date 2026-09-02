import type {
	Contact,
	InjectionRule,
	Message,
	PhoneNumber,
	StateResponse,
	Template,
	TokenState,
	WebhookDelivery,
} from "@whaloc/shared";
import { vi, type Mock } from "vitest";
import { initialState } from "../store/reducer.ts";
import type { AppState } from "../store/types.ts";

/** Shapes the control plane would answer with, minus the parts a test does not care about. */

export const PHONE_NUMBER_ID = "573542517421694";
export const WABA_ID = "666635535888644";
export const CONTACT_WA_ID = "5511912345678";
export const CONVERSATION_ID = `${PHONE_NUMBER_ID}:${CONTACT_WA_ID}`;

/** The second account, for everything that only shows up once whaloc holds more than one. */
export const SECOND_WABA_ID = "102290129340398";
export const SECOND_PHONE_NUMBER_ID = "111222333444555";
/** The third, for the rules that only start applying past two (Settings collapses cards). */
export const THIRD_WABA_ID = "339900112233445";

export function makeMessage(overrides: Partial<Message> = {}): Message {
	const timestamp = overrides.timestamp ?? "2026-08-31T12:00:00.000Z";

	return {
		id: "wamid.1",
		direction: "outbound",
		phoneNumberId: PHONE_NUMBER_ID,
		contactWaId: CONTACT_WA_ID,
		type: "text",
		payload: { text: { body: "hello" } },
		status: "accepted",
		error: null,
		replyTo: null,
		timestamp,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}

/** A contact with no business-scoped user id — the default, since none is ever seeded. */
export function makeContact(overrides: Partial<Contact> = {}): Contact {
	return {
		waId: CONTACT_WA_ID,
		profileName: "Ana Souza",
		userId: null,
		createdAt: "2026-08-31T12:00:00.000Z",
		updatedAt: "2026-08-31T12:00:00.000Z",
		...overrides,
	};
}

export function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
	return {
		id: "delivery-1",
		eventType: "messages",
		url: "https://receiver.test/meta-webhooks",
		requestBody: '{"object":"whatsapp_business_account","entry":[]}',
		requestHeaders: { "content-type": "application/json", "x-hub-signature-256": "sha256=abc" },
		responseStatus: 200,
		responseBody: '{"ok":true}',
		error: null,
		attempt: 1,
		durationMs: 12,
		skipped: false,
		createdAt: "2026-08-31T12:00:00.000Z",
		...overrides,
	};
}

export function makeTemplate(overrides: Partial<Template> = {}): Template {
	return {
		id: "1234567890",
		wabaId: WABA_ID,
		name: "order_update",
		language: "en_US",
		category: "UTILITY",
		parameterFormat: "POSITIONAL",
		components: [{ type: "BODY", text: "Your order {{1}} shipped" }],
		status: "PENDING",
		rejectedReason: null,
		qualityScore: null,
		createdAt: "2026-08-31T12:00:00.000Z",
		updatedAt: "2026-08-31T12:00:00.000Z",
		...overrides,
	};
}

/** A fully onboarded phone number: `CONNECTED`, verified, nothing pending. */
export function makePhoneNumber(overrides: Partial<PhoneNumber> = {}): PhoneNumber {
	return {
		id: PHONE_NUMBER_ID,
		wabaId: WABA_ID,
		displayPhoneNumber: "+55 11 91234-5678",
		verifiedName: "whaloc Test Business",
		qualityRating: "GREEN",
		throughputLevel: "STANDARD",
		status: "CONNECTED",
		codeVerificationStatus: "VERIFIED",
		nameStatus: "APPROVED",
		pendingVerification: null,
		businessProfile: {},
		createdAt: "2026-08-31T12:00:00.000Z",
		...overrides,
	};
}

/** An armed `next 3` rate-limit rule on the send endpoint — the shape a dev arms most often. */
export function makeInjectionRule(overrides: Partial<InjectionRule> = {}): InjectionRule {
	return {
		id: "0199aa1b2c3d0000a1b2c3d4e5f60718",
		target: "messages.send",
		trigger: { kind: "next", count: 3 },
		preset: "rate_limit_429",
		retryAfterSeconds: 60,
		regainAccessMinutes: 15,
		seen: 0,
		matches: 0,
		remaining: 3,
		exhausted: false,
		createdAt: "2026-08-31T12:00:00.000Z",
		updatedAt: "2026-08-31T12:00:00.000Z",
		...overrides,
	};
}

export function makeToken(overrides: Partial<TokenState> = {}): TokenState {
	return {
		id: "0123456789abcdef",
		masked: "••••••••oken",
		last4: "oken",
		expired: false,
		expiredAt: null,
		...overrides,
	};
}

export function makeStateResponse(overrides: Partial<StateResponse> = {}): StateResponse {
	return {
		publicUrl: "http://localhost:8080",
		app: { id: "701093815387936", name: "whaloc" },
		wabas: [
			{
				id: WABA_ID,
				name: "whaloc Test Business",
				subscribedAt: null,
				phoneNumbers: [makePhoneNumber()],
			},
		],
		behavior: {
			statusDelays: { sent: 0, delivered: 800, read: null },
			templateAutoApproveMs: 2000,
			strictTokens: false,
			mediaTtlSeconds: null,
		},
		webhook: {
			url: "https://receiver.test/meta-webhooks",
			appSecretConfigured: true,
			verifyTokenConfigured: true,
			verifyOnStart: false,
			lastHandshake: null,
		},
		...overrides,
	};
}

/**
 * Two WABAs, the second one with a number of its own — the shape every scope question needs:
 * which account a number belongs to, and what happens when the first one is empty.
 */
export function makeTwoWabaState(options: { firstHasNumbers?: boolean } = {}): StateResponse {
	return makeStateResponse({
		wabas: [
			{
				id: WABA_ID,
				name: "whaloc Test Business",
				subscribedAt: null,
				phoneNumbers: options.firstHasNumbers === false ? [] : [makePhoneNumber()],
			},
			{
				id: SECOND_WABA_ID,
				name: "Second Business",
				subscribedAt: null,
				phoneNumbers: [
					makePhoneNumber({
						id: SECOND_PHONE_NUMBER_ID,
						wabaId: SECOND_WABA_ID,
						displayPhoneNumber: "+1 631-555-5555",
					}),
				],
			},
		],
	});
}

export function makeAppState(overrides: Partial<AppState> = {}): AppState {
	return {
		...initialState,
		phase: "ready",
		server: makeStateResponse(),
		wabaId: WABA_ID,
		phoneNumberId: PHONE_NUMBER_ID,
		contacts: [],
		// Loaded at bootstrap in the real store, so an empty list — not `null` — is the default.
		injectionRules: [],
		errorPresets: [
			{ code: 131_049, title: "Healthy ecosystem engagement", message: "…", details: "…" },
			{ code: 131_026, title: "Message undeliverable", message: "…", details: "…" },
		],
		...overrides,
	};
}

/** The bits of `Response` the API client reads; jsdom has no `fetch` of its own. */
export function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status < 400,
		status,
		text: () => Promise.resolve(JSON.stringify(body)),
	} as unknown as Response;
}

export type FetchStub = (input: string, init?: RequestInit) => Promise<Response>;
export type FetchMock = Mock<FetchStub>;

/** Replaces `fetch` with a typed mock, so a spec can assert on the request that went out. */
export function stubFetch(implementation: FetchStub): FetchMock {
	const mock = vi.fn(implementation);

	vi.stubGlobal("fetch", mock);

	return mock;
}

/** The parsed JSON body of the nth request the mock recorded. */
export function requestBodyOf(mock: FetchMock, call = 0): unknown {
	const body = mock.mock.calls[call]?.[1]?.body;

	return JSON.parse(typeof body === "string" ? body : "null");
}
