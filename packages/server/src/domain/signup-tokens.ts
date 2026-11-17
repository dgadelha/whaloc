import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The business tokens `oauth/access_token` issues for an Embedded Signup (SPEC §2.23).
 *
 * A token **carries its own grant**: the WABA IDs the popup shared, plus a signature keyed by
 * the app's ID and secret. That is what lets `debug_token` answer and the strict token gate
 * (SPEC §1.9) accept one without a table holding credentials, and after a restart, which is
 * what a consumer that stored the token expects. The same grant always yields the same token.
 */
const TOKEN_PATTERN = /^EAAW([\w-]+)\.([\w-]+)$/;
const SIGNATURE_BYTES = 18;

export interface SignupTokenIssuerOptions {
	appId: string;
	/** `WHALOC_APP_SECRET`; unset, the signature is keyed by the app ID alone. */
	appSecret?: string | undefined;
}

export class SignupTokenIssuer {
	readonly #key: string;

	constructor(options: SignupTokenIssuerOptions) {
		this.#key = `${options.appId}:${options.appSecret ?? ""}`;
	}

	#sign(payload: string): Buffer {
		return createHmac("sha256", this.#key).update(payload).digest().subarray(0, SIGNATURE_BYTES);
	}

	issue(wabaIds: readonly string[]): string {
		const payload = Buffer.from(wabaIds.join(","), "utf8").toString("base64url");

		return `EAAW${payload}.${this.#sign(payload).toString("base64url")}`;
	}

	/** The WABA IDs a token this issuer minted grants, or `null` for any other string. */
	grantsOf(token: string): string[] | null {
		const match = TOKEN_PATTERN.exec(token);

		if (match === null) {
			return null;
		}

		const [, payload = "", signature = ""] = match;
		const expected = this.#sign(payload);
		const received = Buffer.from(signature, "base64url");

		if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
			return null;
		}

		return Buffer.from(payload, "base64url").toString("utf8").split(",");
	}
}
