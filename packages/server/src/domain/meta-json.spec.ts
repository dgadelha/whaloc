import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { metaSignatureHeader, serializeMetaJson, SIGNATURE_HEADER, isValidMetaSignature } from "./meta-json.ts";

/**
 * The vectors are whap's (`src/server/middleware/hmac-signature.test.ts`), which were checked
 * against `openssl dgst -sha256 -hmac` and Python's `hmac` module. They are reproduced here
 * unchanged: whaloc signs the bytes a receiver built against Meta expects, or it signs
 * nothing useful at all.
 */
const SECRET = "test-app-secret";
const BODY = '{"object":"whatsapp_business_account"}';

describe("serializeMetaJson", () => {
	it("leaves a purely ASCII payload alone", () => {
		expect(serializeMetaJson({ object: "whatsapp_business_account" })).toBe(BODY);
	});

	it.each([
		["café", String.raw`{"message":"caf\u00e9"}`],
		["ñ", String.raw`{"message":"\u00f1"}`],
		["ü", String.raw`{"message":"\u00fc"}`],
		// U+1F355 SLICE OF PIZZA — above the BMP, so JSON.stringify already emits the two
		// surrogate halves and both are escaped.
		["\u{1F355}", String.raw`{"message":"\ud83c\udf55"}`],
		["olá 🇧🇷", String.raw`{"message":"ol\u00e1 \ud83c\udde7\ud83c\uddf7"}`],
		["日本語", String.raw`{"message":"\u65e5\u672c\u8a9e"}`],
	])(String.raw`escapes %j as \uXXXX`, (message, expected) => {
		expect(serializeMetaJson({ message })).toBe(expected);
	});

	it("keeps the ASCII around an escape intact", () => {
		expect(serializeMetaJson({ text: "hello é" })).toBe(String.raw`{"text":"hello \u00e9"}`);
	});

	it("escapes a run of non-ASCII characters one by one", () => {
		expect(serializeMetaJson({ text: "éñü" })).toBe(String.raw`{"text":"\u00e9\u00f1\u00fc"}`);
	});

	it("escapes keys as well as values", () => {
		expect(serializeMetaJson({ "café": 1 })).toBe(String.raw`{"caf\u00e9":1}`);
	});

	it("produces a body that is pure ASCII, so its bytes and its characters are the same count", () => {
		const body = serializeMetaJson({ message: "olá 🍕" });

		expect(Buffer.byteLength(body, "utf8")).toBe(body.length);
	});
});

describe("metaSignatureHeader", () => {
	it("is the header name a receiver looks up", () => {
		expect(SIGNATURE_HEADER).toBe("x-hub-signature-256");
	});

	it("matches the openssl reference digest", () => {
		// echo -n '{"object":"whatsapp_business_account"}' | openssl dgst -sha256 -hmac 'test-app-secret'
		expect(metaSignatureHeader(SECRET, BODY)).toBe(
			"sha256=b6978b21c4467654c466607663db9b43fae44b71083568df403e0a077089208e",
		);
	});

	it.each([
		[String.raw`{"message":"caf\u00e9"}`, "sha256=5980113abfc4ffe911f1ae78f92dcf41e10b7d6bc792efd48dfe9ee94131aaf4"],
		[String.raw`{"message":"\u00f1"}`, "sha256=354180ffbc36b3aa59251edd86d5ebbd4b96f6b0e8b86c0e33de972ed522b4a9"],
		[String.raw`{"message":"\u00fc"}`, "sha256=4d9bf627365de9d0375f6bf7d097103d0707887ac70b7e7f89eee7149785d456"],
		[String.raw`{"message":"\ud83c\udf55"}`, "sha256=a3fe6b4ad5e3ef4df08e3dd66f4ed304d3ad5b34bb9da8f1da445acc6088a507"],
		[String.raw`{"text":"hello \u00e9"}`, "sha256=332fbd50e77a205c8668b7d665d0c0abdf38c6770cbd1fbfebc5854d60859da0"],
	])("signs the escaped body %s", (body, expected) => {
		expect(metaSignatureHeader(SECRET, body)).toBe(expected);
	});

	it("is deterministic", () => {
		expect(metaSignatureHeader(SECRET, BODY)).toBe(metaSignatureHeader(SECRET, BODY));
	});

	it("changes with the secret", () => {
		expect(metaSignatureHeader("secret-a", BODY)).not.toBe(metaSignatureHeader("secret-b", BODY));
	});

	it("changes with the body", () => {
		expect(metaSignatureHeader(SECRET, BODY)).not.toBe(metaSignatureHeader(SECRET, '{"object":"different"}'));
	});

	it("signs an empty body", () => {
		expect(metaSignatureHeader(SECRET, "")).toMatch(/^sha256=[\da-f]{64}$/);
	});

	it("differs from the digest of the raw UTF-8 body", () => {
		// The regression guard: if the serializer is ever bypassed, the signature stops
		// matching what a receiver computes over the bytes Meta would have sent.
		expect(metaSignatureHeader(SECRET, '{"message":"café"}')).not.toBe(
			metaSignatureHeader(SECRET, String.raw`{"message":"caf\u00e9"}`),
		);
	});

	it("agrees with node:crypto used directly", () => {
		const expected = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;

		expect(metaSignatureHeader(SECRET, BODY)).toBe(expected);
	});
});

describe("isValidMetaSignature", () => {
	it("accepts a signature it produced", () => {
		expect(isValidMetaSignature(metaSignatureHeader(SECRET, BODY), SECRET, BODY)).toBe(true);
	});

	it.each([
		["a wrong digest", "sha256=".padEnd(71, "0"), SECRET, BODY],
		["a wrong secret", metaSignatureHeader("other-secret", BODY), SECRET, BODY],
		["a different body", metaSignatureHeader(SECRET, BODY), SECRET, '{"object":"different"}'],
		["a truncated digest", "sha256=deadbeef", SECRET, BODY],
		["a missing prefix", "deadbeef", SECRET, BODY],
		["a non-hex digest", `sha256=${"z".repeat(64)}`, SECRET, BODY],
	])("rejects %s", (_name, header, secret, body) => {
		expect(isValidMetaSignature(header, secret, body)).toBe(false);
	});

	it("verifies the multibyte payload end to end", () => {
		const body = serializeMetaJson({ messages: [{ text: { body: "Olá! 🍕 日本語" } }] });

		expect(isValidMetaSignature(metaSignatureHeader(SECRET, body), SECRET, body)).toBe(true);
	});
});
