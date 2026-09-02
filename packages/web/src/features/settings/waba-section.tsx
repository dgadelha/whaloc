import type { AppIdentity, WabaState } from "@whaloc/shared";
import { useId, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { CopyButton } from "../../components/copy-button.tsx";
import { CreatePhoneNumberDialog } from "../../components/create-phone-number-dialog.tsx";
import { Dialog } from "../../components/dialog.tsx";
import { formatTimestamp } from "../../lib/format.ts";
import { useAction, useDispatch, useToasts } from "../../store/store.tsx";
import { AccountEventsCard } from "./account-events-card.tsx";
import { PhoneNumberCard } from "./phone-number-card.tsx";

/**
 * One WABA and the numbers under it (SPEC §5): the ids an integration has to be configured with,
 * renaming, deleting — which takes everything below it — and the action that adds a number.
 *
 * **A card, not a run of sections.** whaloc holds as many accounts as a dev cares to create, and
 * each one expanded is a screenful; the header is therefore the summary worth scanning — name,
 * id, how many numbers, whether an app subscribed — and everything that acts on the account
 * lives inside. Which cards start open is the Accounts section's call, not this one's.
 *
 * "Add number…" opens the shell's own dialog: here and in the breadcrumb's number menu it has to
 * stay one flow. A number added either way is `CONNECTED` and can send immediately; the
 * unverified path is the Graph API's `POST /{wabaId}/phone_numbers`, and a number that walks it
 * shows its verification code on its own card.
 */

function RenameDialog(props: { waba: WabaState; onClose: () => void }) {
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [name, setName] = useState(props.waba.name);
	const [saving, setSaving] = useState(false);

	const save = (): void => {
		setSaving(true);

		void (async () => {
			try {
				const waba = await api.renameWaba(props.waba.id, name.trim());

				dispatch({ type: "ws/event", event: { type: "waba.changed", payload: { waba, event: "updated" } } });
				toasts.info(`renamed to ${waba.name}`);
				props.onClose();
			} catch (error) {
				toasts.error(error);
			} finally {
				setSaving(false);
			}
		})();
	};

	return (
		<Dialog
			title="Rename WABA"
			subtitle="The name `GET /{wabaId}?fields=name` reports."
			onClose={props.onClose}
			footer={
				<>
					<button type="button" className="button" onClick={props.onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="button button--primary"
						disabled={saving || name.trim() === ""}
						onClick={save}
					>
						{saving ? "saving…" : "Save"}
					</button>
				</>
			}
		>
			<label className="field">
				<span className="field__label">Name</span>
				<input
					className="input"
					aria-label="WABA name"
					value={name}
					onChange={changed => {
						setName(changed.target.value);
					}}
				/>
			</label>
		</Dialog>
	);
}

/**
 * Whether an app is subscribed to this WABA's webhooks (SPEC §2.20), read-only: only the app
 * under test can subscribe, through `POST /{wabaId}/subscribed_apps`. Deliveries go to
 * `WHALOC_WEBHOOK_URL` either way, which the copy says so nobody debugs a silence that is not
 * there.
 */
function SubscriptionRow(props: { waba: WabaState; app: AppIdentity }) {
	const { subscribedAt } = props.waba;

	return (
		<div className="row row--wrap">
			<span className={`badge ${subscribedAt === null ? "" : "badge--ok"}`}>
				{subscribedAt === null ? "no app subscribed" : "app subscribed"}
			</span>
			{subscribedAt === null ? (
				<span className="faint">
					<code>POST /{props.waba.id}/subscribed_apps</code> registers {props.app.name} (app id{" "}
					<code>{props.app.id}</code>). Webhooks are delivered either way.
				</span>
			) : (
				<span className="faint">
					{props.app.name} (app id <code>{props.app.id}</code>) since {formatTimestamp(subscribedAt)}
				</span>
			)}
		</div>
	);
}

export interface WabaSectionProps {
	waba: WabaState;
	publicUrl: string;
	app: AppIdentity;
	/** Whether the body is showing; the Accounts section owns the answer. */
	isOpen: boolean;
	onToggle: () => void;
}

export function WabaSection(props: WabaSectionProps) {
	const { waba, isOpen } = props;
	const bodyId = useId();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [isRenaming, setIsRenaming] = useState(false);
	const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
	const [isAddingPhoneNumber, setIsAddingPhoneNumber] = useState(false);
	const count = waba.phoneNumbers.length;

	const remove = (): void => {
		run(async () => {
			const deleted = await api.deleteWaba(waba.id);

			dispatch({ type: "ws/event", event: { type: "waba.changed", payload: { waba: deleted, event: "deleted" } } });
			setIsConfirmingDelete(false);
			toasts.info(`${deleted.name} deleted`);
		});
	};

	return (
		<section className="card stack waba">
			<div className="row row--wrap">
				<h3 className="waba__heading">
					<button
						type="button"
						className="waba__toggle"
						aria-expanded={isOpen}
						aria-controls={bodyId}
						onClick={props.onToggle}
					>
						<span className="waba__caret" aria-hidden="true">
							{isOpen ? "▾" : "▸"}
						</span>
						{waba.name}
					</button>
				</h3>
				<span className="badge">{count === 1 ? "1 number" : `${String(count)} numbers`}</span>
				{/* Shorter than the row inside says it, so the two never collide when both are on screen. */}
				{waba.subscribedAt !== null && <span className="badge badge--ok">subscribed</span>}
				<span className="spacer" />
				<span className="chip">{waba.id}</span>
				<CopyButton value={waba.id} label="WABA id" />
			</div>

			{isOpen && (
				<div id={bodyId} className="stack">
					<div className="row row--wrap">
						<button
							type="button"
							className="button button--sm"
							aria-label={`Rename WABA ${waba.name}`}
							onClick={() => {
								setIsRenaming(true);
							}}
						>
							Rename…
						</button>
						<button
							type="button"
							className="button button--sm"
							aria-label={`Add a phone number to ${waba.name}`}
							onClick={() => {
								setIsAddingPhoneNumber(true);
							}}
						>
							Add number…
						</button>
						<span className="spacer" />
						<button
							type="button"
							className="button button--sm button--danger"
							aria-label={`Delete WABA ${waba.name}`}
							onClick={() => {
								setIsConfirmingDelete(true);
							}}
						>
							Delete…
						</button>
					</div>

					<p className="faint">
						The app under test points <code>GRAPH_API_BASE_URL</code> at <code>{props.publicUrl}/v25.0</code>.
					</p>

					<SubscriptionRow waba={waba} app={props.app} />

					{count === 0 ? (
						<p className="empty">
							No phone numbers yet — “Add number…” above, or POST to /v25.0/{waba.id}/phone_numbers.
						</p>
					) : (
						waba.phoneNumbers.map(phoneNumber => <PhoneNumberCard key={phoneNumber.id} phoneNumber={phoneNumber} />)
					)}

					{/* Last, because it is about the account rather than about any of its numbers. */}
					<AccountEventsCard waba={waba} />
				</div>
			)}

			{isRenaming && (
				<RenameDialog
					waba={waba}
					onClose={() => {
						setIsRenaming(false);
					}}
				/>
			)}

			{isAddingPhoneNumber && (
				<CreatePhoneNumberDialog
					wabaId={waba.id}
					wabaName={waba.name}
					onClose={() => {
						setIsAddingPhoneNumber(false);
					}}
				/>
			)}

			{isConfirmingDelete && (
				<Dialog
					title={`Delete ${waba.name}?`}
					subtitle="Its phone numbers, their conversations and its templates go with it."
					onClose={() => {
						setIsConfirmingDelete(false);
					}}
					footer={
						<>
							<button
								type="button"
								className="button"
								onClick={() => {
									setIsConfirmingDelete(false);
								}}
							>
								Cancel
							</button>
							<button type="button" className="button button--danger" onClick={remove}>
								Delete WABA
							</button>
						</>
					}
				>
					<p>
						{count === 0
							? "It has no phone numbers."
							: `Its ${String(count)} phone number(s) are deleted too, with every message and media object.`}{" "}
						<code>POST /api/reset</code> brings the seeded WABA back.
					</p>
				</Dialog>
			)}
		</section>
	);
}
