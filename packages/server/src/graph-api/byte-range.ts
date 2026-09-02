/**
 * `Range` parsing for the media byte endpoint (SPEC §1.7). The consumer sends single byte
 * ranges only, so that is what is honored:
 *
 * - `bytes=0-99`, `bytes=100-` and `bytes=-500` become a 206 with `Content-Range`.
 * - A range that starts past the end of the object is unsatisfiable → 416.
 * - Anything else — another unit, a multi-range request, a header that does not parse — is
 *   ignored and the whole object is served, which RFC 9110 §14.2 explicitly allows.
 */

export type ByteRange =
	/** No usable range: serve the whole object with 200. */
	| { kind: "whole" }
	/** Inclusive bounds, both already clamped to the object. */
	| { kind: "range"; start: number; end: number }
	/** Serve 416 with `Content-Range: bytes * /<size>`. */
	| { kind: "unsatisfiable" };

const BYTES_UNIT_PATTERN = /^bytes=(.*)$/i;
const RANGE_SPEC_PATTERN = /^(\d*)-(\d*)$/;

export function parseByteRange(header: string | undefined, size: number): ByteRange {
	if (header === undefined) {
		return { kind: "whole" };
	}

	const unit = BYTES_UNIT_PATTERN.exec(header.trim());

	if (unit === null) {
		return { kind: "whole" };
	}

	const specs = unit[1]!.split(",");

	// Multi-range responses need `multipart/byteranges`; whaloc serves the whole object
	// instead, which is a valid answer to a range request.
	if (specs.length !== 1) {
		return { kind: "whole" };
	}

	const spec = RANGE_SPEC_PATTERN.exec(specs[0]!.trim());

	// A header that does not parse is invalid, not unsatisfiable: RFC 9110 §14.1.1 says to
	// ignore it, and 416 is reserved for a well-formed range the object cannot satisfy.
	if (spec === null) {
		return { kind: "whole" };
	}

	const [, rawStart = "", rawEnd = ""] = spec;

	if (rawStart === "" && rawEnd === "") {
		return { kind: "whole" };
	}

	// A last position before the first makes the spec invalid too (§14.1.1) — ignored likewise.
	if (rawStart !== "" && rawEnd !== "" && Number(rawEnd) < Number(rawStart)) {
		return { kind: "whole" };
	}

	// `bytes=-500` asks for the last 500 bytes.
	const start = rawStart === "" ? Math.max(size - Number(rawEnd), 0) : Number(rawStart);
	const end = rawStart === "" || rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);

	// A well-formed range starting past the end — `bytes=-0` included — is the 416 case.
	// `start >= size` also covers an empty object, where every range is unsatisfiable.
	if (start >= size) {
		return { kind: "unsatisfiable" };
	}

	return { kind: "range", start, end };
}

export function contentRangeHeader(range: { start: number; end: number }, size: number): string {
	return `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`;
}

export function unsatisfiableContentRangeHeader(size: number): string {
	return `bytes */${String(size)}`;
}
