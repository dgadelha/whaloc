import { Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell.tsx";
import { ScopeGate, ScopeRedirect } from "./components/scope-gate.tsx";
import { ChatsPage } from "./features/chats/chats-page.tsx";
import { SettingsPage } from "./features/settings/settings-page.tsx";
import { TemplatesPage } from "./features/templates/templates-page.tsx";
import { WebhooksPage } from "./features/webhooks/webhooks-page.tsx";
import { useAppState } from "./store/store.tsx";

/**
 * The four views of the control plane (SPEC §5, §8), behind the one gate that matters: the UI
 * is useless without `GET /api/state`, so a failed bootstrap says so instead of rendering an
 * empty shell that looks like an empty whaloc.
 */
export function App() {
	const { phase, loadError } = useAppState();

	if (phase === "loading") {
		return (
			<div className="boot">
				<p>Loading whaloc…</p>
			</div>
		);
	}

	if (phase === "failed") {
		return (
			<div className="boot">
				<h1>whaloc is not answering</h1>
				<p className="muted">{loadError}</p>
				<p className="faint">
					The UI is a pure client of <code>/api</code>. Start the server, then reload.
				</p>
				<button
					type="button"
					className="button"
					onClick={() => {
						globalThis.location.reload();
					}}
				>
					Reload
				</button>
			</div>
		);
	}

	return (
		<Routes>
			<Route element={<AppShell />}>
				{/* Scope lives in the path, as deep as the view is scoped (SPEC §5). */}
				<Route
					path="w/:wabaId/p/:phoneNumberId/chats"
					element={
						<ScopeGate view="chats">
							<ChatsPage />
						</ScopeGate>
					}
				/>
				<Route
					path="w/:wabaId/p/:phoneNumberId/chats/:contactWaId"
					element={
						<ScopeGate view="chats">
							<ChatsPage />
						</ScopeGate>
					}
				/>
				{/* A WABA with no number still has a Chats view: the one that offers to add the first. */}
				<Route
					path="w/:wabaId/chats"
					element={
						<ScopeGate view="chats">
							<ChatsPage />
						</ScopeGate>
					}
				/>
				<Route
					path="w/:wabaId/templates"
					element={
						<ScopeGate view="templates">
							<TemplatesPage />
						</ScopeGate>
					}
				/>

				{/* Global views: the delivery log and the settings are about the whole instance. */}
				<Route path="webhooks" element={<WebhooksPage />} />
				<Route path="settings" element={<SettingsPage />} />

				{/* Unscoped entry points land in the last scope this browser used. */}
				<Route index element={<ScopeRedirect view="chats" />} />
				<Route path="chats" element={<ScopeRedirect view="chats" />} />
				<Route path="chats/:conversationId" element={<ScopeRedirect view="chats" />} />
				<Route path="templates" element={<ScopeRedirect view="templates" />} />
				<Route path="*" element={<ScopeRedirect view="chats" />} />
			</Route>
		</Routes>
	);
}
