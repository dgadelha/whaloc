export type ClipboardResult = "copied" | "unavailable";

/**
 * Writing to the clipboard fails in more ways than a promise rejection: the API is missing
 * outside a secure context, and a browser may refuse the write outright. Callers only ever
 * want to know whether the value made it.
 */
export async function copyToClipboard(value: string): Promise<ClipboardResult> {
	try {
		await globalThis.navigator.clipboard.writeText(value);

		return "copied";
	} catch {
		return "unavailable";
	}
}
