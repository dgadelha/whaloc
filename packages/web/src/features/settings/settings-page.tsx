import { BSUID_PATTERN, type Contact, type StateResponse, type WabaState } from "@whaloc/shared";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../../api/endpoints.ts";
import { ChangeNumberDialog } from "../../components/change-number-dialog.tsx";
import { CopyButton } from "../../components/copy-button.tsx";
import { CreateWabaDialog } from "../../components/create-waba-dialog.tsx";
import { useAction, useAppState, useDispatch, useToasts } from "../../store/store.tsx";
import { DangerZoneCard } from "./danger-zone-card.tsx";
import { InjectionCard } from "./injection-card.tsx";
import { TokensCard } from "./tokens-card.tsx";
import { WabaSection } from "./waba-section.tsx";

/**
 * Settings (SPEC §5): the ids an integration needs, the knobs it can turn, and the danger zone.
 *
 * It is the one view that is a **document** rather than a workspace — a column of unrelated
 * subjects, read top to bottom — so it is laid out as one: a bounded, centered column with a
 * sub-nav that names its parts. The parts are the ones that were already here; the reorganisation
 * is what keeps them findable now that the Accounts one grows with every WABA a dev creates.
 */

interface SectionEntry {
	id: string;
	label: string;
}

function SubNav(props: { sections: SectionEntry[] }) {
	return (
		<nav className="subnav" aria-label="Settings sections">
			{props.sections.map(section => (
				<a key={section.id} className="subnav__link" href={`#${section.id}`}>
					{section.label}
				</a>
			))}
		</nav>
	);
}

function Section(props: { id: string; title: string; actions?: ReactNode; children: ReactNode }) {
	return (
		<section id={props.id} className="section stack" aria-labelledby={`${props.id}-title`}>
			<div className="row row--wrap">
				<h2 id={`${props.id}-title`} className="section__title">
					{props.title}
				</h2>
				<span className="spacer" />
				{props.actions}
			</div>
			{props.children}
		</section>
	);
}

/**
 * Which account cards start expanded.
 *
 * Two fit on a screen, so both are shown and the collapsing never gets in the way of the common
 * case. Past that the section is a list to scan, and the one card worth opening is the account
 * the rest of the UI is pointed at. Settings is global — no scope in its URL (SPEC §5) — so it
 * borrows the scope the breadcrumb remembers, which is the last one this developer worked in.
 */
function defaultOpenWabaIds(wabas: WabaState[], scopedWabaId: string | null): Set<string> {
	if (wabas.length <= 2) {
		return new Set(wabas.map(waba => waba.id));
	}

	const scoped = wabas.find(waba => waba.id === scopedWabaId) ?? wabas[0];

	return new Set(scoped === undefined ? [] : [scoped.id]);
}

/**
 * The accounts whaloc is emulating, one card each (SPEC §5). "Create WABA…" is here rather than
 * on a card of its own: it is what this section is *for*, and the breadcrumb's account menu ends
 * in the very same dialog.
 */
function AccountsSection(props: { server: StateResponse; scopedWabaId: string | null }) {
	const { server } = props;
	const [isCreating, setIsCreating] = useState(false);
	// Only the cards a human has clicked; everything else follows the default, so a WABA that
	// arrives over the socket is placed by the same rule as the ones already on screen.
	const [toggled, setToggled] = useState<Record<string, boolean>>({});
	const defaults = useMemo(
		() => defaultOpenWabaIds(server.wabas, props.scopedWabaId),
		[server.wabas, props.scopedWabaId],
	);

	return (
		<Section
			id="accounts"
			title="Accounts"
			actions={
				<button
					type="button"
					className="button"
					onClick={() => {
						setIsCreating(true);
					}}
				>
					Create WABA…
				</button>
			}
		>
			{server.wabas.length === 0 ? (
				<p className="empty">
					No WABA left — “Create WABA…” above, or <code>POST /api/reset</code> to bring the seeded one back.
				</p>
			) : (
				server.wabas.map(waba => (
					<WabaSection
						key={waba.id}
						waba={waba}
						publicUrl={server.publicUrl}
						app={server.app}
						isOpen={toggled[waba.id] ?? defaults.has(waba.id)}
						onToggle={() => {
							setToggled(previous => ({ ...previous, [waba.id]: !(previous[waba.id] ?? defaults.has(waba.id)) }));
						}}
					/>
				))
			)}

			{isCreating && (
				<CreateWabaDialog
					onClose={() => {
						setIsCreating(false);
					}}
					onCreated={created => {
						// Whoever just created it wants to see inside it, whatever the default says.
						setToggled(previous => ({ ...previous, [created.id]: true }));
					}}
				/>
			)}
		</Section>
	);
}

/**
 * The people the UI can act as: the profile name is what the inbound webhook carries, and the
 * optional **BSUID** (SPEC §1.15) is the business-scoped identity it carries alongside `wa_id` —
 * the one a send addressed by `recipient` resolves. Each row can also change number, which is
 * what emits Meta's `user_changed_number` system event (SPEC §5).
 */
function ContactsSection() {
	const { contacts } = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [waId, setWaId] = useState("");
	const [profileName, setProfileName] = useState("");
	const [userId, setUserId] = useState("");
	const [changing, setChanging] = useState<Contact | null>(null);

	const reload = async (): Promise<void> => {
		dispatch({ type: "contacts/loaded", contacts: await api.listContacts() });
	};

	/** A BSUID edit: blank clears it, anything else has to look like one before it is sent. */
	const editUserId = (contact: Contact, value: string): void => {
		const next = value.trim() === "" ? null : value.trim();

		if (next === (contact.userId ?? null)) {
			return;
		}

		if (next !== null && !BSUID_PATTERN.test(next)) {
			toasts.info("A BSUID looks like BR.ENT.4KgQ2wJ8 or US.4KgQ2wJ8");

			return;
		}

		run(async () => {
			await api.updateContact(contact.waId, { userId: next });
			await reload();
		});
	};

	return (
		<Section id="contacts" title="Contacts">
			<div className="card stack">
				{/* The three columns plus the actions do not fit a narrow window: the table scrolls,
				    the page does not. */}
				<div className="table-scroll">
					<table className="table">
						<thead>
							<tr>
								<th>wa_id</th>
								<th>Profile name</th>
								<th>BSUID</th>
								<th aria-label="Actions" />
							</tr>
						</thead>
						<tbody>
							{(contacts ?? []).map(contact => (
								<tr key={contact.waId}>
									<td className="mono">{contact.waId}</td>
									<td>
										<input
											className="input"
											defaultValue={contact.profileName}
											aria-label={`Profile name of ${contact.waId}`}
											onBlur={changed => {
												const next = changed.target.value.trim();

												if (next !== "" && next !== contact.profileName) {
													run(async () => {
														await api.updateContact(contact.waId, { profileName: next });
														await reload();
													});
												}
											}}
										/>
									</td>
									<td>
										<input
											className="input mono"
											// The row is keyed by wa_id, so a number change remounts it with the
											// moved contact's own value — no stale `defaultValue` to clear.
											defaultValue={contact.userId ?? ""}
											placeholder="none"
											aria-label={`BSUID of ${contact.waId}`}
											onBlur={changed => {
												editUserId(contact, changed.target.value);
											}}
										/>
									</td>
									<td>
										<div className="row">
											<button
												type="button"
												className="button button--ghost"
												onClick={() => {
													setChanging(contact);
												}}
											>
												Number…
											</button>
											<CopyButton value={contact.waId} label="wa_id" />
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<hr className="divider" />

				<form
					className="row row--wrap"
					onSubmit={submit => {
						submit.preventDefault();

						if (waId.trim() === "" || profileName.trim() === "") {
							toasts.info("A contact needs a wa_id and a profile name");

							return;
						}

						if (userId.trim() !== "" && !BSUID_PATTERN.test(userId.trim())) {
							toasts.info("A BSUID looks like BR.ENT.4KgQ2wJ8 or US.4KgQ2wJ8");

							return;
						}

						run(async () => {
							await api.createContact({
								waId: waId.trim(),
								profileName: profileName.trim(),
								...(userId.trim() !== "" && { userId: userId.trim() }),
							});
							await reload();
							setWaId("");
							setProfileName("");
							setUserId("");
						});
					}}
				>
					<input
						className="input settings__input"
						placeholder="wa_id (digits)"
						aria-label="New contact wa_id"
						value={waId}
						onChange={changed => {
							setWaId(changed.target.value);
						}}
					/>
					<input
						className="input settings__input"
						placeholder="profile name"
						aria-label="New contact profile name"
						value={profileName}
						onChange={changed => {
							setProfileName(changed.target.value);
						}}
					/>
					<input
						className="input settings__input"
						placeholder="BSUID (optional)"
						aria-label="New contact BSUID"
						value={userId}
						onChange={changed => {
							setUserId(changed.target.value);
						}}
					/>
					<button type="submit" className="button">
						Add contact
					</button>
				</form>

				<p className="faint">
					A contact with a BSUID adds <code>user_id</code> / <code>from_user_id</code> to its inbound webhooks and{" "}
					<code>recipient_user_id</code> to the statuses of messages sent to it, and can be addressed by{" "}
					<code>recipient</code> instead of <code>to</code>. The seeded contacts ship with one BSUID of each shape, and
					a <code>WHALOC_SEED</code> contact may set its own via <code>userId</code>.
				</p>
			</div>

			{changing !== null && (
				<ChangeNumberDialog
					contact={changing}
					onClose={() => {
						setChanging(null);
					}}
					onChanged={() => {
						run(reload);
					}}
				/>
			)}
		</Section>
	);
}

/** What whaloc booted with (SPEC §7) — read-only, and the reason a delay looks "wrong". */
function BehaviorSection(props: { server: StateResponse }) {
	const { behavior } = props.server;

	return (
		<Section id="behavior" title="Behavior">
			<div className="card stack">
				<dl className="settings__list">
					<div>
						<dt>sent</dt>
						<dd>{behavior.statusDelays.sent} ms after the send</dd>
					</div>
					<div>
						<dt>delivered</dt>
						<dd>{behavior.statusDelays.delivered} ms after the send</dd>
					</div>
					<div>
						<dt>read</dt>
						<dd>
							{behavior.statusDelays.read === null
								? "manual — mark it from a message's menu"
								: `${String(behavior.statusDelays.read)} ms after the send`}
						</dd>
					</div>
					<div>
						<dt>failed</dt>
						<dd>manual only, from the error presets</dd>
					</div>
					<div>
						<dt>template review</dt>
						<dd>
							{behavior.templateAutoApproveMs === null
								? "manual — approve or reject from Templates"
								: `auto-approved after ${String(behavior.templateAutoApproveMs)} ms`}
						</dd>
					</div>
					<div>
						<dt>media TTL</dt>
						<dd>
							{behavior.mediaTtlSeconds === null
								? "off — uploaded media never expires"
								: `${String(behavior.mediaTtlSeconds)} s, then 400 / code 100 / subcode 33`}
						</dd>
					</div>
					<div>
						<dt>tokens</dt>
						<dd>{behavior.strictTokens ? "only the registered tokens are accepted" : "any non-empty bearer token"}</dd>
					</div>
					<div>
						<dt>public URL</dt>
						<dd className="mono">{props.server.publicUrl}</dd>
					</div>
				</dl>
				<p className="faint">Read-only: these come from the environment whaloc booted with (SPEC §7).</p>
			</div>
		</Section>
	);
}

export function SettingsPage() {
	const { server, wabaId } = useAppState();

	if (server === null) {
		return <div className="empty">loading…</div>;
	}

	// Only with a registry to show: an absent feature does not need a section (SPEC §1.9).
	const hasTokens = server.behavior.strictTokens;
	const sections: SectionEntry[] = [
		{ id: "accounts", label: "Accounts" },
		{ id: "contacts", label: "Contacts" },
		...(hasTokens ? [{ id: "tokens", label: "Access tokens" }] : []),
		{ id: "error-injection", label: "Error injection" },
		{ id: "behavior", label: "Behavior" },
		{ id: "danger-zone", label: "Danger zone" },
	];

	return (
		<div className="page">
			<header className="page__header">
				<div className="page__title">
					<h1>Settings</h1>
					<span className="faint">state, IDs and behavior</span>
				</div>
			</header>

			<div className="page__body page__body--anchored">
				<div className="page__column stack">
					<SubNav sections={sections} />

					<AccountsSection server={server} scopedWabaId={wabaId} />
					<ContactsSection />

					{hasTokens && (
						<Section id="tokens" title="Access tokens">
							<TokensCard />
						</Section>
					)}

					<Section id="error-injection" title="Error injection">
						<InjectionCard />
					</Section>

					<BehaviorSection server={server} />

					<Section id="danger-zone" title="Danger zone">
						<DangerZoneCard />
					</Section>
				</div>
			</div>
		</div>
	);
}
