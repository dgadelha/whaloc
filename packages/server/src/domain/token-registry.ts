import type { TokenState } from "@whaloc/shared";
import { createHash } from "node:crypto";
import type { Repositories } from "../db/index.ts";
import { controlNotFound } from "./control-plane-error.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { expiredAccessTokenError, invalidAccessTokenError } from "./meta-errors.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";

/**
 * The bearer-token registry (SPEC §1.9).
 *
 * **Two modes, and the default is unchanged.** With `WHALOC_TOKENS` unset whaloc is permissive:
 * every non-empty bearer token is accepted, exactly as it always was, and there is nothing to
 * list. With the variable set, only the listed tokens pass — anything else is 401 / code 190 —
 * and each of them can be marked *expired* through the control plane, which is 401 / 190 /
 * **subcode 463**, the envelope a consumer keys "refresh my token" on.
 *
 * Expiry is **persisted** (a row per expired token), so it survives a restart when
 * `WHALOC_DB_PATH` points at a file, and `POST /api/reset` clears it along with everything else.
 * What is persisted is the token's derived id, never the token: the registry lives in the
 * environment, and a `whaloc.db` left on a volume should not be a place credentials leak from.
 */

/** Enough of the digest to be unique among a handful of tokens, short enough to paste in a URL. */
const TOKEN_ID_LENGTH = 16;
/** How many trailing characters stay readable in the masked form. */
const VISIBLE_SUFFIX = 4;
/** A masked token is never longer than this, so one long token cannot stretch the UI. */
const MAX_MASK_DOTS = 12;

/** Stable across restarts, and derived from the token rather than from its position in the list. */
export function tokenId(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, TOKEN_ID_LENGTH);
}

/** `••••••••cdef` — enough to tell two tokens apart, not enough to use one. */
export function maskToken(token: string): string {
	if (token.length <= VISIBLE_SUFFIX) {
		return "•".repeat(token.length);
	}

	return "•".repeat(Math.min(token.length - VISIBLE_SUFFIX, MAX_MASK_DOTS)) + token.slice(-VISIBLE_SUFFIX);
}

export interface TokenRegistryOptions {
	repositories: Repositories;
	/** `WHALOC_TOKENS`; `undefined` — the default — leaves whaloc permissive. */
	tokens?: readonly string[] | undefined;
	events?: EventPublisher;
	scheduler?: Scheduler;
}

export class TokenRegistry {
	readonly #repositories: Repositories;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	/** Derived id → token, in the order `WHALOC_TOKENS` listed them; empty when permissive. */
	readonly #tokens = new Map<string, string>();
	readonly #strict: boolean;

	constructor(options: TokenRegistryOptions) {
		this.#repositories = options.repositories;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#strict = options.tokens !== undefined;

		if (options.tokens !== undefined) {
			for (const token of options.tokens) {
				this.#tokens.set(tokenId(token), token);
			}
		}
	}

	#toState(id: string, token: string, expiredAt: string | null): TokenState {
		return {
			id,
			masked: maskToken(token),
			last4: token.slice(-VISIBLE_SUFFIX),
			expired: expiredAt !== null,
			expiredAt,
		};
	}

	/** `WHALOC_TOKENS` is set: unregistered tokens are rejected. */
	get isStrict(): boolean {
		return this.#strict;
	}

	/**
	 * The gate every Graph request passes (SPEC §1.9). Returns for an acceptable token and
	 * throws the Meta envelope for anything else; the caller has already established that a
	 * non-empty `Bearer` credential was sent.
	 */
	async authenticate(token: string): Promise<void> {
		if (!this.#strict) {
			return;
		}

		const id = tokenId(token);

		if (!this.#tokens.has(id)) {
			throw invalidAccessTokenError();
		}

		const expiredAt = await this.#repositories.expiredTokens.findExpiredAt(id);

		if (expiredAt !== null) {
			throw expiredAccessTokenError(new Date(expiredAt), this.#scheduler.now());
		}
	}

	/** The registry as the control plane serves it — masked, in the order it was configured. */
	async list(): Promise<TokenState[]> {
		const expired = await this.#repositories.expiredTokens.listExpired();

		return [...this.#tokens].map(([id, token]) => this.#toState(id, token, expired.get(id) ?? null));
	}

	/**
	 * Marks one registered token expired, or brings it back. Idempotent in both directions: an
	 * already-expired token keeps the moment it first expired, so the envelope's wording is
	 * stable while it stays expired.
	 */
	async setExpired(id: string, isExpired: boolean): Promise<TokenState> {
		const token = this.#tokens.get(id);

		if (token === undefined) {
			throw controlNotFound(`no registered token with id ${id}`, "unknown_token");
		}

		let expiredAt: string | null = null;

		if (isExpired) {
			expiredAt = await this.#repositories.expiredTokens.expire(id, this.#scheduler.now().toISOString());
		} else {
			await this.#repositories.expiredTokens.restore(id);
		}

		const state = this.#toState(id, token, expiredAt);

		this.#events.publish({ type: "token.changed", payload: { token: state } });

		return state;
	}
}
