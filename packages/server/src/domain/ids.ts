import { createHash, randomBytes } from "node:crypto";

/**
 * Identifier generators shaped like Meta's (SPEC §1.2, §1.3). Every generator takes the byte
 * source as an argument so tests — and the deterministic seeding — can pin it down.
 */
export type RandomBytes = (size: number) => Uint8Array;

export const defaultRandomBytes: RandomBytes = size => randomBytes(size);

/** Meta object ids: digit-only strings, at most 32 characters (SPEC §1.3). */
export const META_ID_PATTERN = /^\d{1,32}$/;
/** `wamid.` + base64 (SPEC §1.2). */
export const WAMID_PATTERN = /^wamid\.[\d+/A-Za-z]+={0,2}$/;
/** `A` + 22 base64url characters, like `AOnodi98JaYHcSTvVvrOtJs` (SPEC §1.4). */
export const FBTRACE_ID_PATTERN = /^A[\w-]{22}$/;

/**
 * Digits used by every generated object id. Fifteen matches the ids Meta hands out
 * (`102290129340398`), stays under the 32-character limit the consumer validates, and keeps
 * template ids below 2^53 so they survive being emitted as JSON numbers (SPEC §1.3).
 */
const ID_DIGITS = 15;

const WAMID_PREFIX = "wamid.";
/** Framing bytes copied from a captured production wamid; both `0x18`s prefix a length. */
const WAMID_HEADER = [0x1c, 0x18] as const;
const WAMID_MIDDLE = [0x15, 0x02, 0x00, 0x11, 0x18] as const;
const WAMID_TRAILER = [0x00] as const;
/** 9 random bytes → the 18 uppercase hex characters the samples carry. */
const WAMID_RANDOM_BYTES = 9;

const MEDIA_URL_TOKEN_BYTES = 24;
const FBTRACE_RANDOM_BYTES = 16;
/** 48 bits of milliseconds + 16 bits of counter + 64 random bits = 32 hex characters. */
const ORDERED_ID_RANDOM_BYTES = 8;
const ORDERED_ID_TIME_DIGITS = 12;
const ORDERED_ID_COUNTER_DIGITS = 4;
const ORDERED_ID_COUNTER_MODULO = 0x1_00_00;
const WEBHOOK_CHALLENGE_BYTES = 16;
/** Meta texts six digits; so does whaloc (SPEC §4). */
const VERIFICATION_CODE_DIGITS = 6;

/** Breaks ties between rows created inside the same millisecond. */
const nextOrderedIdSequence = (() => {
	let sequence = 0;

	return (): number => {
		const current = sequence;

		sequence = (sequence + 1) % ORDERED_ID_COUNTER_MODULO;

		return current;
	};
})();

function toHexUpperCase(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex").toUpperCase();
}

function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/**
 * A Meta-shaped wamid. Decoding one —
 * `wamid.HBgNNTUxMTkxMjM0NTY3OBUCABEYEjYzNEQzNzJFQjhDMkNENzU5OQA=` — gives
 * `1c 18 <len> <recipient digits> 15 02 00 11 18 <len> <18 hex chars> 00`, which is what this
 * rebuilds — same envelope, random tail, so wamids are never reused (SPEC §1.2). The layout is
 * the one Meta emits; the sample above is minted over a synthetic number.
 *
 * `recipient` is the MSISDN (or business-scoped id, SPEC §1.15) the message is addressed to;
 * consumers treat the whole thing as opaque, so an empty recipient is fine too.
 */
export function createWamid(recipient: string, random: RandomBytes = defaultRandomBytes): string {
	const recipientBytes = Buffer.from(recipient, "latin1");

	if (recipientBytes.length > 0xff) {
		throw new RangeError("a wamid recipient cannot be longer than 255 bytes");
	}

	const tail = Buffer.from(toHexUpperCase(random(WAMID_RANDOM_BYTES)), "latin1");
	const bytes = Buffer.concat([
		Buffer.from(WAMID_HEADER),
		Buffer.of(recipientBytes.length),
		recipientBytes,
		Buffer.from(WAMID_MIDDLE),
		Buffer.of(tail.length),
		tail,
		Buffer.from(WAMID_TRAILER),
	]);

	return WAMID_PREFIX + bytes.toString("base64");
}

/** The `fbtrace_id` every Meta response carries, error envelopes included (SPEC §1.4). */
export function createFbtraceId(random: RandomBytes = defaultRandomBytes): string {
	return `A${toBase64Url(random(FBTRACE_RANDOM_BYTES))}`;
}

/**
 * A digit-only object id. The first digit is never zero so the string round-trips through
 * the JSON numbers Meta uses for template ids (SPEC §1.3).
 */
export function createNumericId(random: RandomBytes = defaultRandomBytes, digits: number = ID_DIGITS): string {
	const bytes = random(digits);
	let id = "";

	for (let index = 0; index < digits; index += 1) {
		const byte = bytes[index] ?? 0;

		id += String(index === 0 ? (byte % 9) + 1 : byte % 10);
	}

	return id;
}

export function createWabaId(random?: RandomBytes): string {
	return createNumericId(random);
}

export function createPhoneNumberId(random?: RandomBytes): string {
	return createNumericId(random);
}

export function createMediaId(random?: RandomBytes): string {
	return createNumericId(random);
}

export function createTemplateId(random?: RandomBytes): string {
	return createNumericId(random);
}

/** The opaque token in a `/whaloc-media/:token` URL (SPEC §2.12) — unguessable, not an id. */
export function createMediaUrlToken(random: RandomBytes = defaultRandomBytes): string {
	return toBase64Url(random(MEDIA_URL_TOKEN_BYTES));
}

/** `upload:` + this is the session id the Resumable Upload API hands out (SPEC §2.21). */
export const UPLOAD_SESSION_PREFIX = "upload:";
const UPLOAD_SESSION_BYTES = 18;
const UPLOAD_HANDLE_BYTES = 18;

/**
 * The opaque half of an upload session id. Base64url, so `upload:<id>` is one clean path
 * segment — the colon is Meta's, and Hono routes it as a literal inside the segment.
 */
export function createUploadSessionId(random: RandomBytes = defaultRandomBytes): string {
	return toBase64Url(random(UPLOAD_SESSION_BYTES));
}

/**
 * The **handle** a finished upload produces (SPEC §2.21).
 *
 * Meta's are long colon-separated strings that begin with a version digit and carry the encoded
 * MIME type — `4::aW1hZ2UvcG5n:ARZ…`. whaloc mints the same shape: consumers treat a handle as
 * opaque, and looking like the real thing means a captured Meta handle and a whaloc one are
 * indistinguishable to the code that passes them around.
 */
export function createUploadHandle(fileType: string, random: RandomBytes = defaultRandomBytes): string {
	return `4::${Buffer.from(fileType, "utf8").toString("base64url")}:ARZ${toBase64Url(random(UPLOAD_HANDLE_BYTES))}`;
}

/**
 * A **time-ordered** row id, for whaloc's own tables: milliseconds, then a per-process counter,
 * then randomness, all in hex, so the ids sort lexicographically in creation order.
 *
 * Timestamps alone do not: several rows land in the same millisecond routinely, and a table
 * whose order *is* its behavior — the delivery log read newest first (SPEC §3), the injection
 * rules evaluated in creation order (SPEC §4) — cannot leave that tie to a random id.
 */
export function createOrderedId(random: RandomBytes = defaultRandomBytes, now: number = Date.now()): string {
	const time = now.toString(16).padStart(ORDERED_ID_TIME_DIGITS, "0");
	const sequence = nextOrderedIdSequence().toString(16).padStart(ORDERED_ID_COUNTER_DIGITS, "0");

	return time + sequence + Buffer.from(random(ORDERED_ID_RANDOM_BYTES)).toString("hex");
}

/** Row id of one webhook delivery attempt; whaloc's own, never seen by the consumer. */
export function createWebhookDeliveryId(random?: RandomBytes, now?: number): string {
	return createOrderedId(random, now);
}

/** Row id of one error-injection rule (SPEC §4); ordered, because evaluation order is too. */
export function createInjectionRuleId(random?: RandomBytes, now?: number): string {
	return createOrderedId(random, now);
}

/**
 * The 6-digit code `POST /{phoneNumberId}/request_code` would have texted (SPEC §4).
 *
 * **Derived, not random** (the golden rule): asking twice for the code of the same number gives
 * the same six digits, so a script can hard-code it and a developer who lost the "SMS" can ask
 * again instead of starting over. It never expires either — nothing in whaloc does.
 */
export function deriveVerificationCode(phoneNumberId: string): string {
	return deriveNumericId(`verification_code:${phoneNumberId}`, VERIFICATION_CODE_DIGITS);
}

/** The `hub.challenge` whaloc sends and expects echoed back (SPEC §1.13) — pure randomness. */
export function createWebhookChallenge(random: RandomBytes = defaultRandomBytes): string {
	return Buffer.from(random(WEBHOOK_CHALLENGE_BYTES)).toString("hex");
}

/**
 * Derives a stable digit-only id from a natural key. Seeding uses it for ids left out of
 * `WHALOC_SEED` (SPEC §7), so an `:memory:` database hands out the same WABA and phone
 * number ids on every restart instead of new ones the caller has to look up again.
 */
export function deriveNumericId(key: string, digits: number = ID_DIGITS): string {
	const digest = createHash("sha256").update(key).digest("hex");
	const lowestDigit = 10n ** BigInt(digits - 1);
	const value = (BigInt(`0x${digest}`) % (lowestDigit * 9n)) + lowestDigit;

	return value.toString();
}
