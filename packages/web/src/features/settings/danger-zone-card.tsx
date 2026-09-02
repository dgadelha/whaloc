import { EXPORT_PATH, type ImportSummary } from "@whaloc/shared";
import { useState } from "react";
import { api } from "../../api/endpoints.ts";
import { Dialog } from "../../components/dialog.tsx";
import { useDispatch, useToasts } from "../../store/store.tsx";

/**
 * The three buttons that replace everything (SPEC §5): **export** the whole state to one file,
 * **import** such a file back, and **reset** to `WHALOC_SEED`.
 *
 * Export is a plain link, not a `fetch`: `GET /api/export` answers with an attachment, so the
 * browser saves it without a snapshot ever passing through this bundle. Import and reset both
 * ask first — they are unrecoverable, and an import is the more surprising of the two, since
 * what comes back is somebody else's world rather than the seed everyone knows.
 */

function describeImport(summary: ImportSummary): string {
	const { counts } = summary;

	return [
		`${String(counts.wabas)} WABA(s)`,
		`${String(counts.phoneNumbers)} number(s)`,
		`${String(counts.contacts)} contact(s)`,
		`${String(counts.templates)} template(s)`,
		`${String(counts.messages)} message(s)`,
		`${String(summary.mediaObjects.restored)}/${String(counts.media)} media object(s)`,
	].join(", ");
}

function SnapshotControls() {
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [withDeliveries, setWithDeliveries] = useState(false);
	const [file, setFile] = useState<File | null>(null);
	const [isConfirming, setConfirming] = useState(false);
	const [isImporting, setImporting] = useState(false);

	const runImport = (): void => {
		if (file === null) {
			return;
		}

		setImporting(true);

		void (async () => {
			try {
				const { summary, state } = await api.importState(file);

				// `state.imported` arrives over the socket too; applying the answer keeps the click
				// honest when the socket happens to be down.
				dispatch({ type: "ws/event", event: { type: "state.imported", payload: { state } } });
				setConfirming(false);
				setFile(null);
				toasts.info(`Imported ${describeImport(summary)}`);
			} catch (error) {
				toasts.error(error);
			} finally {
				setImporting(false);
			}
		})();
	};

	return (
		<div className="stack">
			<h4 className="card__subtitle">State snapshot</h4>
			<p className="muted">
				An export is one JSON file holding every table <strong>and the media bytes</strong>, so a scenario travels: send
				the file and the whaloc it lands in is the one it left. An import <strong>replaces everything</strong> — and the
				seed is not re-applied afterwards, because the snapshot is the state.
			</p>

			<div className="row row--wrap">
				<a className="button" href={withDeliveries ? `${EXPORT_PATH}?include=deliveries` : EXPORT_PATH} download>
					Export state
				</a>
				<label className="row">
					<input
						type="checkbox"
						checked={withDeliveries}
						onChange={changed => {
							setWithDeliveries(changed.target.checked);
						}}
					/>
					<span className="faint">include the webhook delivery log</span>
				</label>
			</div>

			<div className="row row--wrap">
				<input
					type="file"
					className="input"
					accept="application/json, .json"
					aria-label="Snapshot file"
					onChange={changed => {
						setFile(changed.target.files?.[0] ?? null);
					}}
				/>
				<button
					type="button"
					className="button button--danger"
					onClick={() => {
						if (file === null) {
							toasts.info("Choose a snapshot file first");

							return;
						}

						setConfirming(true);
					}}
				>
					Import state…
				</button>
			</div>

			{isConfirming && file !== null && (
				<Dialog
					title="Replace all state?"
					subtitle={`${file.name} becomes this whaloc's entire state.`}
					onClose={() => {
						setConfirming(false);
					}}
					footer={
						<>
							<button
								type="button"
								className="button"
								onClick={() => {
									setConfirming(false);
								}}
							>
								Cancel
							</button>
							<button type="button" className="button button--danger" disabled={isImporting} onClick={runImport}>
								{isImporting ? "importing…" : "Import and replace"}
							</button>
						</>
					}
				>
					<p>
						Every WABA, phone number, contact, template, conversation and media object is deleted and replaced by the
						snapshot's. <code>WHALOC_SEED</code> is <strong>not</strong> re-applied — use <code>Reset whaloc</code> for
						that — so the IDs a configured <code>GRAPH_API_BASE_URL</code> points at are the snapshot's IDs.
					</p>
				</Dialog>
			)}
		</div>
	);
}

function ResetControls() {
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [isConfirming, setConfirming] = useState(false);
	const [isResetting, setResetting] = useState(false);

	const reset = (): void => {
		setResetting(true);

		void (async () => {
			try {
				const server = await api.reset();

				// `state.reset` arrives over the socket too; applying the answer keeps the click
				// honest when the socket happens to be down.
				dispatch({ type: "ws/event", event: { type: "state.reset", payload: { state: server } } });
				setConfirming(false);
				toasts.info("whaloc is back to its seeded state");
			} catch (error) {
				toasts.error(error);
			} finally {
				setResetting(false);
			}
		})();
	};

	return (
		<div className="stack">
			<h4 className="card__subtitle">Reset</h4>
			<p className="muted">
				Reset empties every table and deletes the stored media, then applies <code>WHALOC_SEED</code> again. Seeded IDs
				are deterministic, so a configured <code>GRAPH_API_BASE_URL</code> keeps working.
			</p>
			<div className="row">
				<button
					type="button"
					className="button button--danger"
					onClick={() => {
						setConfirming(true);
					}}
				>
					Reset whaloc…
				</button>
			</div>

			{isConfirming && (
				<Dialog
					title="Reset whaloc?"
					subtitle="Messages, templates, media and delivery logs are deleted."
					onClose={() => {
						setConfirming(false);
					}}
					footer={
						<>
							<button
								type="button"
								className="button"
								onClick={() => {
									setConfirming(false);
								}}
							>
								Cancel
							</button>
							<button type="button" className="button button--danger" disabled={isResetting} onClick={reset}>
								{isResetting ? "resetting…" : "Reset everything"}
							</button>
						</>
					}
				>
					<p>The seed is re-applied afterwards, so the WABA, phone numbers and seeded contacts come back.</p>
				</Dialog>
			)}
		</div>
	);
}

export function DangerZoneCard() {
	return (
		<div className="card card--danger stack">
			<SnapshotControls />
			<hr className="rule" />
			<ResetControls />
		</div>
	);
}
