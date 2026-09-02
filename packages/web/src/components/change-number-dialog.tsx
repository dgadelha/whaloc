import type { Contact } from "@whaloc/shared";
import { useState } from "react";
import { api } from "../api/endpoints.ts";
import { useAction, useDispatch, useToasts } from "../store/store.tsx";
import { Dialog } from "./dialog.tsx";

export interface ChangeNumberDialogProps {
	contact: Contact;
	/** Named, the system webhook goes to this number only; omitted, to every conversation's. */
	phoneNumberId?: string;
	onClose: () => void;
	/** Called with the moved contact, so a view on the old conversation id can follow it. */
	onChanged?: (contact: Contact) => void;
}

/**
 * "User changed number…" (SPEC §5): the UI action behind Meta's `user_changed_number` system
 * event. The contact keeps its name, its BSUID and its history — only the number changes, which
 * is exactly what the webhook tells the app under test.
 */
export function ChangeNumberDialog(props: ChangeNumberDialogProps) {
	const { contact } = props;
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [waId, setWaId] = useState("");

	const submit = (): void => {
		const next = waId.trim();

		if (next === "") {
			toasts.info("A number change needs the new wa_id");

			return;
		}

		run(async () => {
			const moved = await api.changeContactNumber(contact.waId, {
				waId: next,
				...(props.phoneNumberId !== undefined && { phoneNumberId: props.phoneNumberId }),
			});

			// The server pushes this too; applying it keeps the click honest with the socket down.
			dispatch({
				type: "ws/event",
				event: { type: "contact.changed", payload: { contact: moved, previousWaId: contact.waId } },
			});
			toasts.info(`${moved.profileName} is now on ${moved.waId}`);
			props.onChanged?.(moved);
			props.onClose();
		});
	};

	return (
		<Dialog
			title="User changed number?"
			subtitle={`${contact.profileName} moves off ${contact.waId}, history included.`}
			onClose={props.onClose}
			footer={
				<>
					<button type="button" className="button" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" className="button button--primary" onClick={submit}>
						Change number
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
				<input
					className="input"
					placeholder="new wa_id (digits)"
					aria-label="New wa_id"
					value={waId}
					onChange={changed => {
						setWaId(changed.target.value);
					}}
				/>
				<p className="faint">
					whaloc emits the <code>user_changed_number</code> system webhook from the old number and moves the
					conversation to the new one. Wamids do not change, so replies and reactions to older messages keep working —
					the derived conversation id does, since it is <code>{"<phoneNumberId>:<waId>"}</code>.
				</p>
			</form>
		</Dialog>
	);
}
