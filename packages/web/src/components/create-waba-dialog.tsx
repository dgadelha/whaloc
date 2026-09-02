import type { Waba } from "@whaloc/shared";
import { useState } from "react";
import { describeError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { useDispatch, useToasts } from "../store/store.tsx";
import { Dialog } from "./dialog.tsx";
import { MetaIdField, metaIdError } from "./meta-id-field.tsx";

/**
 * A second WABA, at runtime (SPEC §5). `WHALOC_SEED` covers the world whaloc boots with; this
 * covers the app that manages several accounts and needs another one to point at.
 *
 * It lives here rather than in Settings because the breadcrumb's account menu ends in the same
 * action: "Create WABA…" from the top bar and from the Accounts section have to be the same
 * flow, or one of them will quietly grow a field the other lacks.
 *
 * Failures are shown **in the dialog** rather than as a toast: the one that matters is a taken
 * id, and it is a correction to make in the field right above the message, with everything else
 * already typed in.
 */
export interface CreateWabaDialogProps {
	onClose: () => void;
	/** Called with the new account, for a caller that wants to navigate into it. */
	onCreated?: (waba: Waba) => void;
}

export function CreateWabaDialog(props: CreateWabaDialogProps) {
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [name, setName] = useState("");
	const [id, setId] = useState("");
	const [failure, setFailure] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const created = (waba: Waba): void => {
		// The socket will say the same thing; applying it here is what makes the click feel
		// instant, and what keeps the flow working when the socket is down.
		dispatch({ type: "ws/event", event: { type: "waba.changed", payload: { waba, event: "created" } } });
		toasts.info(`${waba.name} added`);
		props.onClose();
		props.onCreated?.(waba);
	};

	const submit = (): void => {
		if (name.trim() === "") {
			setFailure("A WABA needs a name");

			return;
		}

		const idError = metaIdError(id);

		if (idError !== null) {
			setFailure(idError);

			return;
		}

		const body = { name: name.trim(), ...(id.trim() !== "" && { id: id.trim() }) };

		setFailure(null);
		setSaving(true);

		void (async () => {
			try {
				created(await api.createWaba(body));
			} catch (error) {
				setFailure(describeError(error));
			} finally {
				setSaving(false);
			}
		})();
	};

	return (
		<Dialog
			title="Add a WABA"
			subtitle="Its ID is generated the way Meta's are (15 digits), or set below to match one you already have."
			onClose={props.onClose}
			footer={
				<>
					<button type="button" className="button" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" className="button button--primary" disabled={saving} onClick={submit}>
						{saving ? "adding…" : "Add WABA"}
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
					<span className="field__label">Name</span>
					<input
						className="input"
						placeholder="business name"
						aria-label="New WABA name"
						value={name}
						onChange={changed => {
							setName(changed.target.value);
						}}
					/>
				</label>

				<MetaIdField
					label="New WABA ID"
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
