import type { StateResponse } from "@whaloc/shared";

/**
 * Scope: which WABA, and which of its phone numbers, the views are looking at (SPEC §5).
 *
 * whaloc manages several WABAs and several numbers at runtime, so "the selected number" is no
 * longer a single global: it is a **path** — account, then number — and it lives in the URL, so
 * a deep link, a reload and a second tab all agree about what is on screen. Everything here is
 * pure, which is what lets the router and the reducer arrive at the same answer: the reducer
 * heals the store when a WebSocket event deletes what was selected, the router redirects the URL
 * to match, and they must not disagree about *where* to go.
 */

export interface Scope {
	wabaId: string | null;
	phoneNumberId: string | null;
}

export const NO_SCOPE: Scope = { wabaId: null, phoneNumberId: null };

/** The four views; the first two carry scope in their path, the last two are global. */
export type View = "chats" | "templates" | "webhooks" | "settings";

/**
 * The closest scope to the one asked for that actually exists.
 *
 * The rules, in order: a **phone number that exists wins** — it is the more specific intent, so
 * a URL naming the right number under the wrong account is repaired rather than thrown away.
 * Otherwise the named WABA is kept if it is still there. Failing both, the first WABA that has a
 * number is preferred over the plain first one: with runtime management an empty account can sit
 * ahead of a populated one, and landing on the empty one would look like an empty whaloc.
 */
export function resolveScope(server: StateResponse | null, wanted: Partial<Scope>): Scope {
	const wabas = server?.wabas ?? [];

	if (wabas.length === 0) {
		return NO_SCOPE;
	}

	const owner =
		wanted.phoneNumberId == null
			? undefined
			: wabas.find(waba => waba.phoneNumbers.some(phoneNumber => phoneNumber.id === wanted.phoneNumberId));
	const named = wanted.wabaId == null ? undefined : wabas.find(waba => waba.id === wanted.wabaId);
	const waba = owner ?? named ?? wabas.find(candidate => candidate.phoneNumbers.length > 0) ?? wabas[0]!;
	const phoneNumber =
		waba.phoneNumbers.find(candidate => candidate.id === wanted.phoneNumberId) ?? waba.phoneNumbers[0];

	return { wabaId: waba.id, phoneNumberId: phoneNumber?.id ?? null };
}

export function isSameScope(a: Scope, b: Scope): boolean {
	return a.wabaId === b.wabaId && a.phoneNumberId === b.phoneNumberId;
}

/**
 * Where a view lives for a given scope — the adaptive depth the breadcrumb shows:
 * `/w/:wabaId/p/:phoneNumberId/chats` for the phone-scoped view, `/w/:wabaId/templates` for the
 * account-scoped one, a bare path for the global ones. `null` means the view cannot be reached
 * from here (no WABA at all), which is what disables its tab.
 */
export function pathFor(view: View, scope: Scope, contactWaId?: string | null): string | null {
	if (view === "webhooks" || view === "settings") {
		return `/${view}`;
	}

	if (scope.wabaId === null) {
		return null;
	}

	const waba = `/w/${encodeURIComponent(scope.wabaId)}`;

	if (view === "templates") {
		return `${waba}/templates`;
	}

	// A WABA with no numbers still has a chats view — the one that offers to add the first number.
	const under = scope.phoneNumberId === null ? waba : `${waba}/p/${encodeURIComponent(scope.phoneNumberId)}`;

	return contactWaId == null ? `${under}/chats` : `${under}/chats/${encodeURIComponent(contactWaId)}`;
}

/** Which view a path belongs to. Anything unrecognised is Chats, the landing view. */
export function viewOf(pathname: string): View {
	const segments = new Set(pathname.split("/"));

	if (segments.has("settings")) {
		return "settings";
	}

	if (segments.has("webhooks")) {
		return "webhooks";
	}

	return segments.has("templates") ? "templates" : "chats";
}

/**
 * The scope the last visit ended on, so `/` lands where the developer left off instead of on
 * whichever account happens to sort first. Persistence is best-effort by design: private mode,
 * a wiped profile or a disabled store must never keep the UI from booting, and the worst case is
 * one redirect to the default scope.
 */
const LAST_SCOPE_KEY = "whaloc:last-scope";

/** Reading it can throw on its own: a browser set to block site data does exactly that. */
function readStored(): string | null {
	try {
		return globalThis.localStorage.getItem(LAST_SCOPE_KEY);
	} catch {
		return null;
	}
}

/** Whatever was stored, narrowed to a scope — an id that is not a string is simply absent. */
function asScope(stored: unknown): Scope {
	if (typeof stored !== "object" || stored === null) {
		return NO_SCOPE;
	}

	const { wabaId, phoneNumberId } = stored as Record<string, unknown>;

	return {
		wabaId: typeof wabaId === "string" ? wabaId : null,
		phoneNumberId: typeof phoneNumberId === "string" ? phoneNumberId : null,
	};
}

export function readLastScope(): Scope {
	const stored = readStored();

	if (stored === null) {
		return NO_SCOPE;
	}

	try {
		return asScope(JSON.parse(stored));
	} catch {
		return NO_SCOPE;
	}
}

export function writeLastScope(scope: Scope): void {
	try {
		globalThis.localStorage.setItem(LAST_SCOPE_KEY, JSON.stringify(scope));
	} catch {
		// A browser that refuses to remember is not a browser that cannot run whaloc.
	}
}
