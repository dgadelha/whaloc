import type { SessionInfoVersion } from "@whaloc/shared";
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

/**
 * How long a code is kept after it expires, so a late exchange is told `expired` rather than
 * `unknown`. Past it the code is forgotten, which keeps the map as small as the last minute.
 */
const EXPIRED_CODE_RETENTION_MS = AUTHORIZATION_CODE_TTL_MS;

/** What the popup asks for, already parsed. */
export interface SignupRequest {
	appId: string;
	sessionInfoVersion: SessionInfoVersion;
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
	data: Record<string, string | boolean | string[]>;
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

	/** The v4 event Meta posts for each path, with the `data` its docs show for that event. */
	#finishV4(wabaId: string, phoneNumber: PhoneNumberRecord | null): SignupSessionEvent {
		const businessId = businessIdOf(wabaId);

		if (phoneNumber === null) {
			return {
				type: "WA_EMBEDDED_SIGNUP",
				event: "FINISH_ONLY_WABA",
				data: { waba_id: wabaId, business_id: businessId },
			};
		}

		if (phoneNumber.isOnBizApp) {
			return {
				type: "WA_EMBEDDED_SIGNUP",
				event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
				data: { waba_id: wabaId },
			};
		}

		return {
			type: "WA_EMBEDDED_SIGNUP",
			event: "FINISH",
			data: { phone_number_id: phoneNumber.id, waba_id: wabaId, business_id: businessId },
		};
	}

	/**
	 * The v5 event: one fixed `data` for every finish, `messaging_account_ids` in place of `waba_id`,
	 * and the event chosen by `is_on_biz_app` alone. whaloc shares no other assets, so their lists
	 * are empty, and Meta leaves `primary_waac_ids` empty until the Graph API exposes those IDs.
	 */
	#finishV5(wabaId: string, phoneNumber: PhoneNumberRecord | null): SignupSessionEvent {
		const isOnBizApp = phoneNumber?.isOnBizApp ?? false;

		return {
			type: "WA_EMBEDDED_SIGNUP",
			event: isOnBizApp ? "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" : "FINISH",
			data: {
				...(phoneNumber !== null && { phone_number_id: phoneNumber.id }),
				is_on_biz_app: isOnBizApp,
				messaging_account_ids: [wabaId],
				primary_waac_ids: [],
				page_ids: [],
				catalog_ids: [],
				dataset_ids: [],
				business_id: businessIdOf(wabaId),
				instagram_account_ids: [],
			},
		};
	}

	/** Forgets codes past their retention, so the map never outgrows the last minute of signups. */
	#pruneCodes(): void {
		const now = this.#scheduler.now().getTime();

		for (const [code, pending] of this.#codes) {
			if (now >= pending.expiresAt + EXPIRED_CODE_RETENTION_MS) {
				this.#codes.delete(code);
			}
		}
	}

	#assertKnownApp(appId: string): void {
		if (!this.isKnownApp(appId)) {
			throw controlBadRequest(`App ID ${appId} is not this whaloc's app.`, "unknown_app");
		}
	}

	/** The choices, checked and applied in the caller's transaction. */
	async #apply(
		request: SignupRequest,
		repositories: Repositories,
	): Promise<{
		wabaId: string;
		createdWaba: WabaRecord | null;
		phoneNumber: PhoneNumberRecord | null;
		created: boolean;
	}> {
		const { waba } = request;

		if (waba.kind === "existing" && (await repositories.wabas.findById(waba.id)) === null) {
			throw controlNotFound(`no WABA with id ${waba.id}`, "unknown_waba");
		}

		if (request.phoneNumber.kind === "existing") {
			const phoneNumber = await repositories.phoneNumbers.findById(request.phoneNumber.id);

			if (phoneNumber === null || waba.kind === "new" || phoneNumber.wabaId !== waba.id) {
				throw controlBadRequest(
					`phone number ${request.phoneNumber.id} does not belong to the chosen WABA`,
					"phone_number_not_in_waba",
				);
			}

			return { wabaId: waba.id, createdWaba: null, phoneNumber, created: false };
		}

		let createdWaba: WabaRecord | null = null;
		let wabaId: string;

		if (waba.kind === "new") {
			createdWaba = await this.#wabas.insert({ name: waba.name }, repositories);
			wabaId = createdWaba.id;
		} else {
			wabaId = waba.id;
		}

		if (request.phoneNumber.kind === "none") {
			return { wabaId, createdWaba, phoneNumber: null, created: false };
		}

		const phoneNumber = await this.#phoneNumbers.onboard(
			{
				wabaId,
				phoneNumber: request.phoneNumber.phoneNumber,
				verifiedName: request.phoneNumber.verifiedName,
				isOnBizApp: request.phoneNumber.coexistence,
			},
			repositories,
		);

		return { wabaId, createdWaba, phoneNumber, created: true };
	}

	/** A reset or an import removes the WABAs the pending codes grant, so the codes go with them. */
	clearCodes(): void {
		this.#codes.clear();
	}

	/** The real SDK refuses an app it does not know; so does the popup. */
	isKnownApp(appId: string | undefined): boolean {
		return appId === this.#appId;
	}

	async choices(appId: string): Promise<SignupChoice[]> {
		this.#assertKnownApp(appId);

		const wabas = await this.#repositories.wabas.list();

		return Promise.all(
			wabas.map(async waba => ({ waba, phoneNumbers: await this.#repositories.phoneNumbers.listByWabaId(waba.id) })),
		);
	}

	/** What an `ERROR` event needs besides the error itself: Meta's session ID and a ms timestamp. */
	errorSession(appId: string): { sessionId: string; timestamp: string } {
		this.#assertKnownApp(appId);

		return {
			sessionId: createSignupSessionId(this.#random),
			timestamp: String(this.#scheduler.now().getTime()),
		};
	}

	/**
	 * Applies the popup's choices and mints the code. The checks and the inserts share one
	 * transaction, so a refusal, even one raced by another request, leaves no half-made WABA behind;
	 * the creations are announced only once it has committed.
	 */
	async complete(request: SignupRequest): Promise<SignupResult> {
		this.#assertKnownApp(request.appId);

		const { wabaId, createdWaba, phoneNumber, created } = await this.#repositories.transaction(async repositories =>
			this.#apply(request, repositories),
		);

		if (createdWaba !== null) {
			this.#wabas.announceCreated(createdWaba);
		}

		if (created && phoneNumber !== null) {
			this.#phoneNumbers.announceCreated(phoneNumber);
		}

		const sessionEvent =
			request.sessionInfoVersion === "v5" ? this.#finishV5(wabaId, phoneNumber) : this.#finishV4(wabaId, phoneNumber);
		const code = createAuthorizationCode(this.#random);

		this.#pruneCodes();

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

		this.#pruneCodes();

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
		// The secret is everything after the first `|`: a configured secret may hold one too.
		const separator = (appToken ?? "").indexOf("|");
		const appId = separator === -1 ? appToken : appToken?.slice(0, separator);
		const appSecret = separator === -1 ? undefined : appToken?.slice(separator + 1);

		if (!this.isKnownApp(appId) || (this.#appSecret !== undefined && appSecret !== this.#appSecret)) {
			throw invalidAccessTokenError();
		}

		return {
			appId: this.#appId,
			wabaIds: inputToken === undefined ? null : this.#signupTokens.grantsOf(inputToken),
		};
	}
}
