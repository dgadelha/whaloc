import { parseConversationId } from "@whaloc/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router";
import {
	pathFor,
	readLastScope,
	resolveScope,
	isSameScope,
	writeLastScope,
	type Scope,
	type View,
} from "../store/scope.ts";
import { useAppState, useDispatch, useToasts } from "../store/store.tsx";
import { CreateWabaDialog } from "./create-waba-dialog.tsx";

/**
 * The scope in the URL, checked against the world that exists (SPEC §5).
 *
 * The URL is the single source of truth for what a view is looking at, so this is the one place
 * that turns a path into a scope: it repairs a path naming a WABA or a number that is gone —
 * deleted here, in another tab, or by a `POST /api/reset` between two page loads — and only then
 * announces the result to the store. Views therefore never see a scope that does not exist, and
 * reloading a stale bookmark lands somewhere real instead of on an error.
 */

/** The two views that carry scope; the global ones are mounted without a gate. */
export type ScopedView = Extract<View, "chats" | "templates">;

export interface ScopeGateProps {
	view: ScopedView;
	children: ReactNode;
}

export function ScopeGate(props: ScopeGateProps) {
	const { server, wabaId, phoneNumberId } = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const params = useParams();
	const wanted: Scope = { wabaId: params["wabaId"] ?? null, phoneNumberId: params["phoneNumberId"] ?? null };
	const contactWaId = params["contactWaId"] ?? null;
	const resolved = resolveScope(server, wanted);

	/*
	 * Is the path telling the truth?
	 *
	 * The WABA has to be the one it names. For Chats the number does too — and a path that names
	 * *no* number is only honest for an account that has none, which is what sends
	 * `/w/:wabaId/chats` down to the account's first number. Templates ignores the number
	 * entirely: it is an account-scoped view, and pinning a number into its URL would be a
	 * promise the view does not keep.
	 */
	const isPhoneHonest =
		props.view === "templates" ||
		(wanted.phoneNumberId === null ? resolved.phoneNumberId === null : resolved.phoneNumberId === wanted.phoneNumberId);
	const isHonest = resolved.wabaId === wanted.wabaId && isPhoneHonest;
	const missing =
		wanted.wabaId !== null && resolved.wabaId !== wanted.wabaId
			? "That WABA is gone"
			: wanted.phoneNumberId !== null && resolved.phoneNumberId !== wanted.phoneNumberId
				? "That phone number is gone"
				: null;
	const notified = useRef<string | null>(null);

	useEffect(() => {
		if (missing === null || notified.current === missing) {
			return;
		}

		notified.current = missing;
		toasts.info(`${missing} — moved to what is there instead.`);
	}, [missing, toasts]);

	useEffect(() => {
		if (!isHonest) {
			return;
		}

		dispatch({ type: "scope/selected", wabaId: resolved.wabaId, phoneNumberId: resolved.phoneNumberId });
		writeLastScope(resolved);
		// A scope is two strings: depending on the object itself would re-run this every render.
	}, [isHonest, resolved.wabaId, resolved.phoneNumberId, dispatch]);

	// Nothing left to scope to: the landing route owns that story, and owns the URL for it.
	if (resolved.wabaId === null) {
		return <Navigate to="/chats" replace />;
	}

	if (!isHonest) {
		// The conversation only survives a repair that kept its number: it is derived from one.
		const keptContact = resolved.phoneNumberId === wanted.phoneNumberId ? contactWaId : null;

		return <Navigate to={pathFor(props.view, resolved, keptContact) ?? "/chats"} replace />;
	}

	// Rendering a view before the store has the scope would load the previous one's data for a
	// frame; the effect above lands on the very next commit.
	return isSameScope(resolved, { wabaId, phoneNumberId }) ? <>{props.children}</> : null;
}

/**
 * Where `/`, a bare `/chats` or `/templates` and anything unrecognised go: into the scope this
 * browser last used, or the default one. A conversation named the old way
 * (`/chats/<phoneNumberId>:<waId>`) is carried across rather than dropped — a bookmark from
 * before this shell still opens the right thread.
 */
export function ScopeRedirect(props: { view: ScopedView }) {
	const { server } = useAppState();
	const params = useParams();
	const legacy = params["conversationId"] === undefined ? null : parseConversationId(params["conversationId"]);
	const wanted: Partial<Scope> = legacy === null ? readLastScope() : { phoneNumberId: legacy.phoneNumberId };
	const resolved = resolveScope(server, wanted);
	const keptContact = legacy !== null && resolved.phoneNumberId === legacy.phoneNumberId ? legacy.contactWaId : null;
	const to = pathFor(props.view, resolved, keptContact);

	return to === null ? <EmptyWorkspace /> : <Navigate to={to} replace />;
}

/**
 * A whaloc with no WABA at all — `WHALOC_SEED` set to `[]`, or every account deleted. Every
 * scoped view is unreachable, so rather than four redirects that lead nowhere the content offers
 * the one action that unblocks them.
 */
export function EmptyWorkspace() {
	const [isAdding, setIsAdding] = useState(false);

	return (
		<div className="hero">
			<h1>No WABA yet</h1>
			<p className="muted">
				whaloc needs a WhatsApp Business Account before it can hold a phone number, a conversation or a template.
			</p>
			<button
				type="button"
				className="button button--primary"
				onClick={() => {
					setIsAdding(true);
				}}
			>
				Create your first WABA
			</button>
			<p className="faint">
				Or bring the seeded one back with <code>POST /api/reset</code>.
			</p>

			{isAdding && (
				<CreateWabaDialog
					onClose={() => {
						setIsAdding(false);
					}}
				/>
			)}
		</div>
	);
}
