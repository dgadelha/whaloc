import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta's webhook JSON serialization and the `X-Hub-Signature-256` it signs (SPEC §1.12).
 *
 * Meta's servers escape every code point above U+007F as `\uXXXX` before hashing, and the
 * signature is computed over exactly the bytes that go on the wire. whaloc reproduces both:
 * {@link serializeMetaJson} is the only place a webhook body is produced, and the same string
 * is handed to {@link metaSignatureHeader} and to `fetch`. Sign anything else — a re-encoded
 * object, a pretty-printed copy — and a receiver that verifies the signature rejects it.
 *
 * Ported from whap's `src/server/middleware/hmac-signature.ts` (`Bun.CryptoHasher` swapped for
 * `node:crypto`), test vectors included.
 */

/** Lowercase header name; HTTP headers are case-insensitive, receivers look it up in lower case. */
export const SIGNATURE_HEADER = "x-hub-signature-256";

const SIGNATURE_PREFIX = "sha256=";

/** A SHA-256 hex digest is always 64 characters. */
const HEX_DIGEST_LENGTH = 64;

/** Code units up to here are ASCII and go through untouched. */
const HIGHEST_ASCII_CODE_UNIT = 0x00_7f;

/**
 * `JSON.stringify` with every non-ASCII code unit escaped as `\uXXXX`, matching what Meta
 * signs. Code points outside the BMP are already emitted as a UTF-16 surrogate pair by
 * `JSON.stringify`, and both halves are above U+007F, so each is escaped on its own: the
 * pizza slice U+1F355 comes out as two escapes, exactly like Meta writes it.
 */
export function serializeMetaJson(value: unknown): string {
	const raw = JSON.stringify(value);
	let result = "";

	for (let index = 0; index < raw.length; index += 1) {
		// `charCodeAt`, not `codePointAt`: Meta escapes UTF-16 **code units**, so an emoji has to
		// come out as its two surrogate halves rather than as a single code point.
		// eslint-disable-next-line unicorn/prefer-code-point
		const code = raw.charCodeAt(index);
		const character = raw[index] ?? "";

		result += code > HIGHEST_ASCII_CODE_UNIT ? String.raw`\u${code.toString(16).padStart(4, "0")}` : character;
	}

	return result;
}

/** Raw HMAC-SHA256 of `body` under `secret`. */
function digest(secret: string, body: string): Buffer {
	return createHmac("sha256", secret).update(body, "utf8").digest();
}

/**
 * The `X-Hub-Signature-256` value for a body: `sha256=<hex>`. `body` must be the string that
 * is actually sent, not the object it was built from.
 */
export function metaSignatureHeader(secret: string, body: string): string {
	return SIGNATURE_PREFIX + digest(secret, body).toString("hex");
}

/**
 * Checks a signature header against a body, in constant time. whaloc never receives signed
 * webhooks, so this exists for the tests and for the smoke-test capture script — it is the
 * check the app under test performs, and keeping it here means it is exercised on every run.
 */
export function isValidMetaSignature(headerValue: string, secret: string, body: string): boolean {
	if (!headerValue.startsWith(SIGNATURE_PREFIX)) {
		return false;
	}

	const incomingHex = headerValue.slice(SIGNATURE_PREFIX.length);

	if (incomingHex.length !== HEX_DIGEST_LENGTH || !/^[\da-f]+$/.test(incomingHex)) {
		return false;
	}

	return timingSafeEqual(Buffer.from(incomingHex, "hex"), digest(secret, body));
}
