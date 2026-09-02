import type { Hash } from "node:crypto";

/**
 * Hashes and counts an upload while it flows past, without ever holding it in memory.
 *
 * Both `MediaStorage` implementations report the SHA-256 and the byte count of what they
 * stored (SPEC §1.7), and both learn them the same way: by measuring the bytes on their way to
 * the destination rather than by reading the object back afterwards.
 */
export function measureWhileStreaming(hash: Hash, onBytes: (byteLength: number) => void) {
	return async function* measure(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
		for await (const chunk of chunks) {
			hash.update(chunk);
			onBytes(chunk.byteLength);

			yield chunk;
		}
	};
}
