/**
 * How the Embedded Signup popup answers the page that opened it (SPEC §2.24): each message as a
 * JSON **string**, because Meta's own listener `JSON.parse`s `event.data`, and only to the origin
 * `FB.login` named, so nothing reaches a page that navigated away meanwhile.
 */

/** The page that opened the dialog: an http(s) origin, nothing more. */
export function originOf(value: string | null): string | null {
	if (value === null || !URL.canParse(value)) {
		return null;
	}

	const url = new URL(value);

	return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? url.origin : null;
}

/** Posts the messages in order, then closes the popup. */
export function postToOpener(origin: string, messages: readonly unknown[]): void {
	const opener = globalThis.opener as Window | null;

	if (opener !== null) {
		for (const message of messages) {
			opener.postMessage(JSON.stringify(message), origin);
		}
	}

	globalThis.close();
}
