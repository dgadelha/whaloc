import { describe, expect, it } from "vitest";
import { contentRangeHeader, parseByteRange, unsatisfiableContentRangeHeader } from "./byte-range.ts";

const SIZE = 1000;

describe("parseByteRange", () => {
	it("serves the whole object when there is no Range header", () => {
		expect(parseByteRange(undefined, SIZE)).toEqual({ kind: "whole" });
	});

	it("reads a closed range", () => {
		expect(parseByteRange("bytes=0-99", SIZE)).toEqual({ kind: "range", start: 0, end: 99 });
		expect(parseByteRange("bytes=200-299", SIZE)).toEqual({ kind: "range", start: 200, end: 299 });
	});

	it("reads an open-ended range", () => {
		expect(parseByteRange("bytes=900-", SIZE)).toEqual({ kind: "range", start: 900, end: 999 });
	});

	it("reads a suffix range as the last bytes", () => {
		expect(parseByteRange("bytes=-500", SIZE)).toEqual({ kind: "range", start: 500, end: 999 });
	});

	it("clamps a suffix longer than the object", () => {
		expect(parseByteRange("bytes=-5000", SIZE)).toEqual({ kind: "range", start: 0, end: 999 });
	});

	it("clamps an end past the object", () => {
		expect(parseByteRange("bytes=990-5000", SIZE)).toEqual({ kind: "range", start: 990, end: 999 });
	});

	it("accepts a single byte", () => {
		expect(parseByteRange("bytes=0-0", SIZE)).toEqual({ kind: "range", start: 0, end: 0 });
	});

	it("tolerates whitespace", () => {
		expect(parseByteRange("  bytes= 10-20 ", SIZE)).toEqual({ kind: "range", start: 10, end: 20 });
	});

	// 416 is for a well-formed range the object cannot satisfy…
	it.each(["bytes=1000-1200", "bytes=5000-", "bytes=-0"])("reports %o as unsatisfiable", header => {
		expect(parseByteRange(header, SIZE)).toEqual({ kind: "unsatisfiable" });
	});

	// …while a malformed spec is an invalid header, ignored per RFC 9110 §14.1.1.
	it.each(["bytes=abc", "bytes=-", "bytes=", "bytes=100-50"])("ignores the invalid header %o", header => {
		expect(parseByteRange(header, SIZE)).toEqual({ kind: "whole" });
	});

	it("reports any range over an empty object as unsatisfiable", () => {
		expect(parseByteRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
	});

	it("ignores a unit it does not serve", () => {
		expect(parseByteRange("items=0-99", SIZE)).toEqual({ kind: "whole" });
	});

	it("ignores a multi-range request rather than answering multipart/byteranges", () => {
		expect(parseByteRange("bytes=0-99,200-299", SIZE)).toEqual({ kind: "whole" });
	});
});

describe("content range headers", () => {
	it("formats a satisfied range", () => {
		expect(contentRangeHeader({ start: 0, end: 99 }, SIZE)).toBe("bytes 0-99/1000");
	});

	it("formats an unsatisfiable one", () => {
		expect(unsatisfiableContentRangeHeader(SIZE)).toBe("bytes */1000");
	});
});
