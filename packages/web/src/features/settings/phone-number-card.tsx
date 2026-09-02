import {
	MESSAGING_LIMITS,
	PHONE_NUMBER_QUALITY_EVENTS,
	QUALITY_RATINGS,
	THROUGHPUT_LEVELS,
	type CodeVerificationStatus,
	type MessagingLimit,
	type PhoneNumber,
	type PhoneNumberQualityEvent,
	type PhoneNumberStatus,
	type QualityRating,
	type ThroughputLevel,
} from "@whaloc/shared";
import { useState } from "react";
import { api } from "../../api/endpoints.ts";
import { CopyButton } from "../../components/copy-button.tsx";
import { Dialog } from "../../components/dialog.tsx";
import { useAction, useDispatch, useToasts } from "../../store/store.tsx";
import { BusinessProfileForm } from "./business-profile-form.tsx";

/**
 * One phone number: where it sits on the registration ladder (SPEC §4), the verification code
 * whaloc would have texted, the quality and throughput `GET /{phoneNumberId}` reports, and the
 * two fields a dev usually wants to fix.
 */

/** Statuses that are on the way somewhere rather than a problem to look into. */
const IN_PROGRESS_STATUSES = new Set<PhoneNumberStatus>(["PENDING", "UNVERIFIED", "UNKNOWN"]);

/** `CONNECTED` is the only status that can send; the rest read as "not right now". */
function statusTone(status: PhoneNumberStatus): string {
	if (status === "CONNECTED") {
		return "badge--ok";
	}

	return IN_PROGRESS_STATUSES.has(status) ? "badge--warn" : "badge--danger";
}

function verificationTone(status: CodeVerificationStatus): string {
	switch (status) {
		case "VERIFIED": {
			return "badge--ok";
		}
		case "NOT_VERIFIED": {
			return "badge--warn";
		}
		default: {
			return "badge--danger";
		}
	}
}

/** The code a Graph `request_code` generated — whaloc is the phone, so this is the "SMS". */
function PendingCode(props: { phoneNumber: PhoneNumber }) {
	const pending = props.phoneNumber.pendingVerification;

	if (pending === null) {
		return null;
	}

	return (
		<div className="row row--wrap">
			<span className="badge badge--info">verification code</span>
			<span className="chip">{pending.code}</span>
			<CopyButton value={pending.code} label="verification code" />
			<span className="faint">
				requested by {pending.method} in {pending.language} — confirm it with{" "}
				<code>POST /{props.phoneNumber.id}/verify_code</code>
			</span>
		</div>
	);
}

function EditDialog(props: { phoneNumber: PhoneNumber; onClose: () => void }) {
	const { phoneNumber } = props;
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [displayPhoneNumber, setDisplayPhoneNumber] = useState(phoneNumber.displayPhoneNumber);
	const [verifiedName, setVerifiedName] = useState(phoneNumber.verifiedName);
	const [saving, setSaving] = useState(false);

	const save = (): void => {
		setSaving(true);

		void (async () => {
			try {
				const updated = await api.updatePhoneNumber(phoneNumber.id, { displayPhoneNumber, verifiedName });

				dispatch({
					type: "ws/event",
					event: { type: "phone_number.changed", payload: { phoneNumber: updated, event: "updated" } },
				});
				toasts.info(`${updated.displayPhoneNumber} updated`);
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
			title="Edit phone number"
			subtitle="The display number is what webhooks report (as digits) and what the UI shows."
			onClose={props.onClose}
			footer={
				<>
					<button type="button" className="button" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" className="button button--primary" disabled={saving} onClick={save}>
						{saving ? "saving…" : "Save"}
					</button>
				</>
			}
		>
			<div className="stack">
				<label className="field">
					<span className="field__label">Display phone number</span>
					<input
						className="input"
						aria-label="Display phone number"
						value={displayPhoneNumber}
						onChange={changed => {
							setDisplayPhoneNumber(changed.target.value);
						}}
					/>
				</label>
				<label className="field">
					<span className="field__label">Verified name</span>
					<input
						className="input"
						aria-label="Verified name"
						value={verifiedName}
						onChange={changed => {
							setVerifiedName(changed.target.value);
						}}
					/>
				</label>
			</div>
		</Dialog>
	);
}

export interface PhoneNumberCardProps {
	phoneNumber: PhoneNumber;
}

/**
 * The webhook fields of the quality form only appear once the toggle is on, because they exist
 * solely to shape that payload (SPEC §5).
 */
export function PhoneNumberCard(props: PhoneNumberCardProps) {
	const { phoneNumber } = props;
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [qualityRating, setQualityRating] = useState<QualityRating>(phoneNumber.qualityRating);
	const [throughputLevel, setThroughputLevel] = useState<ThroughputLevel>(phoneNumber.throughputLevel);
	const [emitWebhook, setEmitWebhook] = useState(false);
	const [event, setEvent] = useState<PhoneNumberQualityEvent>("UPGRADE");
	const [currentLimit, setCurrentLimit] = useState<MessagingLimit>("TIER_1K");
	const [saving, setSaving] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

	const save = (): void => {
		setSaving(true);

		// The webhook fields only mean anything when the change is being announced.
		const request = { qualityRating, throughputLevel, emitWebhook, ...(emitWebhook && { event, currentLimit }) };

		void (async () => {
			try {
				const updated = await api.setPhoneNumberQuality(phoneNumber.id, request);

				dispatch({
					type: "ws/event",
					event: { type: "phone_number.changed", payload: { phoneNumber: updated, event: "updated" } },
				});
				toasts.info(`${phoneNumber.displayPhoneNumber} updated`);
			} catch (error) {
				toasts.error(error);
			} finally {
				setSaving(false);
			}
		})();
	};

	const remove = (): void => {
		run(async () => {
			const deleted = await api.deletePhoneNumber(phoneNumber.id);

			dispatch({
				type: "ws/event",
				event: { type: "phone_number.changed", payload: { phoneNumber: deleted, event: "deleted" } },
			});
			setIsConfirmingDelete(false);
			toasts.info(`${deleted.displayPhoneNumber} deleted`);
		});
	};

	return (
		<div className="card stack">
			<div className="row row--wrap">
				<h3>{phoneNumber.displayPhoneNumber}</h3>
				<span className="badge">{phoneNumber.verifiedName}</span>
				<span className={`badge ${statusTone(phoneNumber.status)}`}>{phoneNumber.status}</span>
				<span className={`badge ${verificationTone(phoneNumber.codeVerificationStatus)}`}>
					{phoneNumber.codeVerificationStatus}
				</span>
				<span className="spacer" />
				<span className="chip">{phoneNumber.id}</span>
				<CopyButton value={phoneNumber.id} label="phone number id" />
				<button
					type="button"
					className="button button--sm"
					aria-label={`Edit ${phoneNumber.displayPhoneNumber}`}
					onClick={() => {
						setIsEditing(true);
					}}
				>
					Edit…
				</button>
				<button
					type="button"
					className="button button--sm button--danger"
					aria-label={`Delete ${phoneNumber.displayPhoneNumber}`}
					onClick={() => {
						setIsConfirmingDelete(true);
					}}
				>
					Delete…
				</button>
			</div>

			{phoneNumber.status !== "CONNECTED" && (
				<p className="faint">
					Not registered on the Cloud API: sends from this number answer <code>133010</code> until{" "}
					<code>POST /{phoneNumber.id}/register</code> succeeds.
				</p>
			)}

			<PendingCode phoneNumber={phoneNumber} />

			<div className="settings__grid">
				<label className="field">
					<span className="field__label">Quality rating</span>
					<select
						className="select"
						value={qualityRating}
						onChange={changed => {
							setQualityRating(changed.target.value as QualityRating);
						}}
					>
						{QUALITY_RATINGS.map(rating => (
							<option key={rating} value={rating}>
								{rating}
							</option>
						))}
					</select>
				</label>

				<label className="field">
					<span className="field__label">Throughput</span>
					<select
						className="select"
						value={throughputLevel}
						onChange={changed => {
							setThroughputLevel(changed.target.value as ThroughputLevel);
						}}
					>
						{THROUGHPUT_LEVELS.map(level => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</label>

				{emitWebhook && (
					<>
						<label className="field">
							<span className="field__label">Webhook event</span>
							<select
								className="select"
								value={event}
								onChange={changed => {
									setEvent(changed.target.value as PhoneNumberQualityEvent);
								}}
							>
								{PHONE_NUMBER_QUALITY_EVENTS.map(candidate => (
									<option key={candidate} value={candidate}>
										{candidate}
									</option>
								))}
							</select>
						</label>

						<label className="field">
							<span className="field__label">current_limit</span>
							<select
								className="select"
								value={currentLimit}
								onChange={changed => {
									setCurrentLimit(changed.target.value as MessagingLimit);
								}}
							>
								{MESSAGING_LIMITS.map(limit => (
									<option key={limit} value={limit}>
										{limit}
									</option>
								))}
							</select>
						</label>
					</>
				)}
			</div>

			<div className="row row--wrap">
				<label className="checkbox">
					<input
						type="checkbox"
						checked={emitWebhook}
						onChange={changed => {
							setEmitWebhook(changed.target.checked);
						}}
					/>
					emit phone_number_quality_update
				</label>
				<span className="spacer" />
				<button type="button" className="button button--primary" disabled={saving} onClick={save}>
					{saving ? "saving…" : "Apply"}
				</button>
			</div>

			<BusinessProfileForm phoneNumber={phoneNumber} />

			{isEditing && (
				<EditDialog
					phoneNumber={phoneNumber}
					onClose={() => {
						setIsEditing(false);
					}}
				/>
			)}

			{isConfirmingDelete && (
				<Dialog
					title={`Delete ${phoneNumber.displayPhoneNumber}?`}
					subtitle="Its conversations, messages and media go with it."
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
								Delete phone number
							</button>
						</>
					}
				>
					<p>
						An app configured with <code>{phoneNumber.id}</code> starts getting the missing-object envelope (
						<code>400</code>, <code>code: 100</code>, <code>error_subcode: 33</code>) on every call.
					</p>
				</Dialog>
			)}
		</div>
	);
}
