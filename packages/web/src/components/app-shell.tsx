import type { WabaState } from "@whaloc/shared";
import clsx from "clsx";
import { useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { pathFor, resolveScope, viewOf, type View } from "../store/scope.ts";
import { useAppState } from "../store/store.tsx";
import { ConnectionBadge } from "./connection-badge.tsx";
import { CreatePhoneNumberDialog } from "./create-phone-number-dialog.tsx";
import { CreateWabaDialog } from "./create-waba-dialog.tsx";
import { InjectionBadge } from "./injection-badge.tsx";
import { ScopeMenu } from "./scope-menu.tsx";
import { Toasts } from "./toasts.tsx";

/**
 * The top bar, and the whole frame under it.
 *
 * One horizontal bar carries everything that is not a view: the brand, the scope as a
 * breadcrumb, the four view tabs and the two live indicators. The scope reads as a path —
 * *account, then number* — because that is what whaloc's world is now that both are managed at
 * runtime, and because a breadcrumb can be **deeper for some views than for others**: Chats is
 * scoped to a phone number, Templates only to a WABA, Webhooks and Settings to nothing at all.
 * Showing a number picker above a view that ignores it was the old shell's quiet lie.
 *
 * Every segment is also where the *next* one is created, so an empty whaloc can be filled in
 * without going looking for the form in Settings.
 */

const TABS: { view: View; label: string }[] = [
	{ view: "chats", label: "Chats" },
	{ view: "templates", label: "Templates" },
	{ view: "webhooks", label: "Webhooks" },
	{ view: "settings", label: "Settings" },
];

/** How deep the breadcrumb goes for the view on screen. */
function depthOf(view: View): 0 | 1 | 2 {
	if (view === "webhooks" || view === "settings") {
		return 0;
	}

	return view === "templates" ? 1 : 2;
}

function ScopeBreadcrumb(props: { view: View }) {
	const { server, wabaId, phoneNumberId } = useAppState();
	const navigate = useNavigate();
	const [isAddingWaba, setIsAddingWaba] = useState(false);
	const [isAddingPhoneNumber, setIsAddingPhoneNumber] = useState(false);
	const depth = depthOf(props.view);

	if (depth === 0) {
		return null;
	}

	const wabas: WabaState[] = server?.wabas ?? [];
	const waba = wabas.find(candidate => candidate.id === wabaId) ?? null;

	// Switching account keeps the view and takes its first number with it, which is what makes the
	// two segments behave like one path instead of two independent pickers.
	const goToWaba = (id: string): void => {
		void navigate(pathFor(props.view, resolveScope(server, { wabaId: id })) ?? "/settings");
	};

	return (
		<nav className="topbar__scope" aria-label="Scope">
			<ScopeMenu
				label="WABA"
				current={waba?.name ?? "No WABA"}
				currentHint={waba?.id}
				isEmpty={waba === null}
				items={wabas.map(candidate => ({ id: candidate.id, label: candidate.name, hint: candidate.id }))}
				selectedId={wabaId}
				onSelect={goToWaba}
				action={{
					label: "Create WABA…",
					onSelect: () => {
						setIsAddingWaba(true);
					},
				}}
			/>

			{/* No account means no numbers to hang under it: one segment, and it says what to do. */}
			{depth === 2 && waba !== null && (
				<>
					<span className="topbar__separator" aria-hidden="true">
						/
					</span>
					<ScopeMenu
						label="Phone number"
						current={
							waba.phoneNumbers.find(candidate => candidate.id === phoneNumberId)?.displayPhoneNumber ?? "No number"
						}
						currentHint={phoneNumberId ?? undefined}
						isEmpty={phoneNumberId === null}
						items={waba.phoneNumbers.map(phoneNumber => ({
							id: phoneNumber.id,
							label: phoneNumber.displayPhoneNumber,
							hint: phoneNumber.id,
							// Only when it is not the boring answer: a number off the ladder cannot send.
							badge: phoneNumber.status === "CONNECTED" ? undefined : phoneNumber.status,
						}))}
						selectedId={phoneNumberId}
						onSelect={id => {
							void navigate(pathFor("chats", { wabaId, phoneNumberId: id }) ?? "/settings");
						}}
						action={{
							label: "Add number…",
							onSelect: () => {
								setIsAddingPhoneNumber(true);
							},
						}}
					/>
				</>
			)}

			{isAddingWaba && (
				<CreateWabaDialog
					onClose={() => {
						setIsAddingWaba(false);
					}}
					onCreated={created => {
						void navigate(pathFor(props.view, { wabaId: created.id, phoneNumberId: null }) ?? "/settings");
					}}
				/>
			)}

			{isAddingPhoneNumber && waba !== null && (
				<CreatePhoneNumberDialog
					wabaId={waba.id}
					wabaName={waba.name}
					onClose={() => {
						setIsAddingPhoneNumber(false);
					}}
					onCreated={created => {
						void navigate(pathFor("chats", { wabaId: waba.id, phoneNumberId: created.id }) ?? "/settings");
					}}
				/>
			)}
		</nav>
	);
}

function ViewTabs() {
	const state = useAppState();
	const unreadTotal = Object.values(state.unread).reduce((total, count) => total + count, 0);
	const scope = { wabaId: state.wabaId, phoneNumberId: state.phoneNumberId };

	return (
		<nav className="topbar__tabs" aria-label="Views">
			{TABS.map(tab => {
				const to = pathFor(tab.view, scope);

				// With no WABA at all there is nowhere for a scoped view to point: the tab says so
				// by being disabled rather than by leading somewhere that redirects straight back.
				if (to === null) {
					return (
						<span key={tab.view} className="tab tab--disabled" aria-disabled="true" title="Create a WABA first">
							{tab.label}
						</span>
					);
				}

				return (
					<NavLink key={tab.view} to={to} className={({ isActive }) => clsx("tab", isActive && "is-active")}>
						<span>{tab.label}</span>
						{tab.view === "chats" && unreadTotal > 0 && <span className="tab__count">{unreadTotal}</span>}
					</NavLink>
				);
			})}
		</nav>
	);
}

export function AppShell() {
	const view = viewOf(useLocation().pathname);

	return (
		<div className="shell">
			<header className="topbar">
				{/* Home: `/` re-resolves to the last-used scope's chats, like a fresh visit. */}
				<Link className="topbar__brand" to="/">
					<span className="topbar__brand-dot" aria-hidden="true" />
					<span className="topbar__brand-name">whaloc</span>
				</Link>

				<ScopeBreadcrumb view={view} />

				<ViewTabs />

				<div className="topbar__status">
					<InjectionBadge />
					<ConnectionBadge />
				</div>
			</header>

			<main className="content">
				<Outlet />
			</main>

			<Toasts />
		</div>
	);
}
