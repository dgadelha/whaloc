import type { PhoneNumberRecord, Repositories, WabaRecord } from "../db/index.ts";
import { controlBadRequest, controlNotFound } from "./control-plane-error.ts";
import {
	createAuthorizationCode,
	createSignupSessionId,
	defaultRandomBytes,
	deriveNumericId,
	type RandomBytes,
} from "./ids.ts";
import {
	invalidAccessTokenError,
	invalidApplicationIdError,
	invalidAuthorizationCodeError,
	invalidClientSecretError,
} from "./meta-errors.ts";
import type { PhoneNumberService } from "./phone-number-service.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import type { SignupTokenIssuer } from "./signup-tokens.ts";
import type { WabaService } from "./waba-service.ts";

/**
 * Embedded Signup, played end to end (SPEC §2.23-§2.24): the popup's choices become WABAs and
 * numbers, the `code` it hands the page is exchanged for a business token, and `debug_token`
 * reports which WABAs that token was granted.
 *
 * Codes live **in memory** only: Meta gives them 30 seconds, so a restart dropping one is the
 * same trade the status ladder makes with its timers (SPEC §4). The tokens they become do not
 * need storage at all, see {@link SignupTokenIssuer}.
 */

/** Meta: "The exchangeable token code has a time-to-live of 30 seconds." */
export const AUTHORIZATION_CODE_TTL_MS = 30_000;

/** What the popup asks for, already parsed. */
export interface SignupRequest {
	appId: string;
	waba: { kind: "existing"; id: string } | { kind: "new"; name: string };
	phoneNumber:
		| { kind: "none" }
		| { kind: "existing"; id: string }
		| { kind: "new"; phoneNumber: string; verifiedName: string; coexistence: boolean };
}

/** Meta's three finish events (SPEC §2.24). */
export type SignupFinishEvent = "FINISH" | "FINISH_ONLY_WABA" | "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";

/** The session logging message the popup posts to the page, before it is stringified. */
export interface SignupSessionEvent {
	type: "WA_EMBEDDED_SIGNUP";
	event: SignupFinishEvent;
	data: Record<string, string>;
}

export interface SignupResult {
	code: string;
	sessionEvent: SignupSessionEvent;
}

/** A WABA with its numbers, for the popup's pickers. */
export interface SignupChoice {
	waba: WabaRecord;
	phoneNumbers: PhoneNumberRecord[];
}

export interface ExchangeCodeInput {
	clientId: string | undefined;
	clientSecret: string | undefined;
	code: string | undefined;
}

/** What `debug_token` reports; `null` WABAs mean the token is not one whaloc issued. */
export interface TokenDebugInfo {
	appId: string;
	wabaIds: string[] | null;
}

interface PendingCode {
	wabaIds: string[];
	expiresAt: number;
	exchanged: boolean;
}

export interface EmbeddedSignupServiceOptions {
	repositories: Repositories;
	wabas: WabaService;
	phoneNumbers: PhoneNumberService;
	signupTokens: SignupTokenIssuer;
	/** The app `subscribed_apps` reports (SPEC §2.20): the only one the popup and the exchange accept. */
	appId: string;
	/** `WHALOC_APP_SECRET`; unset, any `client_secret` is accepted, like any bearer token is. */
	appSecret?: string | undefined;
	scheduler?: Scheduler;
	random?: RandomBytes;
}

/**
 * whaloc has no business portfolios, yet two finish events name one. It is derived from the
 * WABA, so a WABA always reports the same portfolio.
 */
export function businessIdOf(wabaId: string): string {
	return deriveNumericId(`business:${wabaId}`);
}

export class EmbeddedSignupService {
	readonly #repositories: Repositories;
	readonly #wabas: WabaService;
	readonly #phoneNumbers: PhoneNumberService;
	readonly #signupTokens: SignupTokenIssuer;
	readonly #appId: string;
	readonly #appSecret: string | undefined;
	readonly #scheduler: Scheduler;
	readonly #random: RandomBytes;
	readonly #codes = new Map<string, PendingCode>();

	constructor(options: EmbeddedSignupServiceOptions) {
		this.#repositories = options.repositories;
		this.#wabas = options.wabas;
		this.#phoneNumbers = options.phoneNumbers;
		this.#signupTokens = options.signupTokens;
		this.#appId = options.appId;
		this.#appSecret = options.appSecret;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#random = options.random ?? defaultRandomBytes;
	}

	async #createWaba(name: string): Promise<string> {
		const waba = await this.#wabas.create({ name });

		return waba.id;
	}

	/** The event Meta posts for each path, with the `data` its docs show for that event. */
	async #finish(wabaId: string, phoneNumber: SignupRequest["phoneNumber"]): Promise<SignupSessionEvent> {
		const businessId = businessIdOf(wabaId);

		if (phoneNumber.kind === "none") {
			return {
				type: "WA_EMBEDDED_SIGNUP",
				event: "FINISH_ONLY_WABA",
				data: { waba_id: wabaId, business_id: businessId },
			};
		}

		const finish = (phoneNumberId: string): SignupSessionEvent => {
			return {
				type: "WA_EMBEDDED_SIGNUP",
				event: "FINISH",
				data: { phone_number_id: phoneNumberId, waba_id: wabaId, business_id: businessId },
			};
		};

		if (phoneNumber.kind === "existing") {
			return finish(phoneNumber.id);
		}

		const created = await this.#phoneNumbers.onboard({
			wabaId,
			phoneNumber: phoneNumber.phoneNumber,
			verifiedName: phoneNumber.verifiedName,
			isOnBizApp: phoneNumber.coexistence,
		});

		return phoneNumber.coexistence
			? { type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: wabaId } }
			: finish(created.id);
	}

	/** The real SDK refuses an app it does not know; so does the popup. */
	isKnownApp(appId: string | undefined): boolean {
		return appId === this.#appId;
	}

	async choices(): Promise<SignupChoice[]> {
		const wabas = await this.#repositories.wabas.list();

		return Promise.all(
			wabas.map(async waba => ({ waba, phoneNumbers: await this.#repositories.phoneNumbers.listByWabaId(waba.id) })),
		);
	}

	/** What an `ERROR` event needs besides the error itself: Meta's session ID and a ms timestamp. */
	errorSession(): { sessionId: string; timestamp: string } {
		return {
			sessionId: createSignupSessionId(this.#random),
			timestamp: String(this.#scheduler.now().getTime()),
		};
	}

	/**
	 * Applies the popup's choices and mints the code. Everything that can be refused is checked
	 * before anything is created, so a refusal leaves no half-made WABA behind.
	 */
	async complete(request: SignupRequest): Promise<SignupResult> {
		if (!this.isKnownApp(request.appId)) {
			throw controlBadRequest(`app ${request.appId} is not whaloc's app`, "unknown_app");
		}

		if (request.waba.kind === "existing" && (await this.#repositories.wabas.findById(request.waba.id)) === null) {
			throw controlNotFound(`no WABA with id ${request.waba.id}`, "unknown_waba");
		}

		if (request.phoneNumber.kind === "existing") {
			const phoneNumber = await this.#repositories.phoneNumbers.findById(request.phoneNumber.id);

			if (phoneNumber === null || request.waba.kind === "new" || phoneNumber.wabaId !== request.waba.id) {
				throw controlBadRequest(
					`phone number ${request.phoneNumber.id} does not belong to the chosen WABA`,
					"phone_number_not_in_waba",
				);
			}
		} else if (request.phoneNumber.kind === "new") {
			await this.#phoneNumbers.assertCanOnboard(request.phoneNumber.phoneNumber);
		}

		const wabaId = request.waba.kind === "new" ? await this.#createWaba(request.waba.name) : request.waba.id;
		const sessionEvent = await this.#finish(wabaId, request.phoneNumber);
		const code = createAuthorizationCode(this.#random);

		this.#codes.set(code, {
			wabaIds: [wabaId],
			expiresAt: this.#scheduler.now().getTime() + AUTHORIZATION_CODE_TTL_MS,
			exchanged: false,
		});

		return { code, sessionEvent };
	}

	/** `GET /oauth/access_token`: one code, one token, within 30 seconds. */
	exchangeCode(input: ExchangeCodeInput): string {
		if (!this.isKnownApp(input.clientId)) {
			throw invalidApplicationIdError();
		}

		if (this.#appSecret !== undefined && input.clientSecret !== this.#appSecret) {
			throw invalidClientSecretError();
		}

		const pending = input.code === undefined ? undefined : this.#codes.get(input.code);

		if (pending === undefined) {
			throw invalidAuthorizationCodeError("unknown");
		}

		if (pending.exchanged) {
			throw invalidAuthorizationCodeError("used");
		}

		if (this.#scheduler.now().getTime() >= pending.expiresAt) {
			throw invalidAuthorizationCodeError("expired");
		}

		pending.exchanged = true;

		return this.#signupTokens.issue(pending.wabaIds);
	}

	/**
	 * `GET /debug_token`, authenticated by the app token `{app-id}|{app-secret}`. Any token whaloc
	 * did not issue through Embedded Signup is reported invalid, whatever the bearer gate thinks
	 * of it: that gate does not know what a token was granted, and a grant is what is asked here.
	 */
	debugToken(appToken: string | undefined, inputToken: string | undefined): TokenDebugInfo {
		const [appId, appSecret] = (appToken ?? "").split("|", 2);

		if (!this.isKnownApp(appId) || (this.#appSecret !== undefined && appSecret !== this.#appSecret)) {
			throw invalidAccessTokenError();
		}

		return {
			appId: this.#appId,
			wabaIds: inputToken === undefined ? null : this.#signupTokens.grantsOf(inputToken),
		};
	}
}
