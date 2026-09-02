import type { PhoneNumber } from "@whaloc/shared";
import { useState } from "react";
import { describeError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { useDispatch, useToasts } from "../store/store.tsx";
import { Dialog } from "./dialog.tsx";
import { MetaIdField, metaIdError } from "./meta-id-field.tsx";

/**
 * Adding a number under a WABA (SPEC §5): a display number and a verified name, the two things a
 * number cannot lack, plus the id it should carry when the app under test already names one.
 *
 * A number added here is `CONNECTED` and can send immediately — the "already onboarded" path.
 * The unverified one is the Graph API's `POST /{wabaId}/phone_numbers`, and a number that walks
 * it shows its verification code on its card in Settings.
 *
 * Shared by Settings and by the breadcrumb's number menu, which ends in the same action. Like its
 * sibling, a failure is shown in the dialog: a taken id is a correction, not a notification.
 */
export interface CreatePhoneNumberDialogProps {
	wabaId: string;
	/** Named in the dialog's subtitle, so "add a number" says *where*. */
	wabaName?: string | undefined;
	onClose: () => void;
	onCreated?: (phoneNumber: PhoneNumber) => void;
}

export function CreatePhoneNumberDialog(props: CreatePhoneNumberDialogProps) {
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [displayPhoneNumber, setDisplayPhoneNumber] = useState("");
	const [verifiedName, setVerifiedName] = useState("");
	const [id, setId] = useState("");
	const [failure, setFailure] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const created = (phoneNumber: PhoneNumber): void => {
		dispatch({
			type: "ws/event",
			event: { type: "phone_number.changed", payload: { phoneNumber, event: "created" } },
		});
		toasts.info(`${phoneNumber.displayPhoneNumber} added`);
		props.onClose();
		props.onCreated?.(phoneNumber);
	};

	const submit = (): void => {
		if (displayPhoneNumber.trim() === "" || verifiedName.trim() === "") {
			setFailure("A phone number needs a display number and a verified name");

			return;
		}

		const idError = metaIdError(id);

		if (idError !== null) {
			setFailure(idError);

			return;
		}

		const body = {
			wabaId: props.wabaId,
			displayPhoneNumber: displayPhoneNumber.trim(),
			verifiedName: verifiedName.trim(),
			...(id.trim() !== "" && { id: id.trim() }),
		};

		setFailure(null);
		setSaving(true);

		void (async () => {
			try {
				created(await api.createPhoneNumber(body));
			} catch (error) {
				setFailure(describeError(error));
			} finally {
				setSaving(false);
			}
		})();
	};

	return (
		<Dialog
			title="Add a phone number"
			subtitle={
				props.wabaName === undefined
					? "It is CONNECTED and verified from the start, so it can send immediately."
					: `Under ${props.wabaName}. It is CONNECTED and verified from the start, so it can send immediately.`
			}
			onClose={props.onClose}
			footer={
				<>
					<button type="button" className="button" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" className="button button--primary" disabled={saving} onClick={submit}>
						{saving ? "adding…" : "Add phone number"}
					</button>
				</>
			}
		>
			<form
				className="stack"
				onSubmit={event => {
					event.preventDefault();
					submit();
				}}
			>
				<label className="field">
					<span className="field__label">Display number</span>
					<input
						className="input"
						placeholder="+1 631-555-5555"
						aria-label="New phone number display number"
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
						placeholder="verified name"
						aria-label="New phone number verified name"
						value={verifiedName}
						onChange={changed => {
							setVerifiedName(changed.target.value);
						}}
					/>
				</label>

				<MetaIdField
					label="New phone number ID"
					value={id}
					onChange={changed => {
						setId(changed);
					}}
				/>

				{failure !== null && (
					<p className="field__error" role="alert">
						{failure}
					</p>
				)}
			</form>
		</Dialog>
	);
}
