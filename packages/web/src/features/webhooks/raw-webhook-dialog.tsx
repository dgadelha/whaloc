import type { JsonObject } from "@whaloc/shared";
import { useState } from "react";
import { Dialog } from "../../components/dialog.tsx";
import { asRecord } from "../../lib/json.ts";

export interface RawWebhookDialogProps {
	onClose: () => void;
	onSend: (payload: JsonObject) => void;
}

/** An envelope in Meta's shape, so the editor opens on something that will actually deliver. */
const EXAMPLE = JSON.stringify(
	{
		object: "whatsapp_business_account",
		entry: [{ id: "<wabaId>", changes: [{ value: {}, field: "messages" }] }],
	},
	null,
	2,
);

/**
 * `POST /api/webhook/raw` (SPEC §3): any JSON object, serialized and signed like a real event.
 * The escape hatch for payloads whaloc does not model — the JSON is validated here so the
 * dialog can point at the syntax error instead of the toast doing it after a round trip.
 */
export function RawWebhookDialog(props: RawWebhookDialogProps) {
	const [text, setText] = useState(EXAMPLE);
	const [error, setError] = useState<string | null>(null);

	const send = (): void => {
		let parsed: unknown;

		try {
			parsed = JSON.parse(text);
		} catch (error_) {
			setError(Error.isError(error_) ? error_.message : "invalid JSON");

			return;
		}

		const payload = asRecord(parsed);

		if (payload === null) {
			setError("the payload must be a JSON object");

			return;
		}

		setError(null);
		props.onSend(payload);
	};

	return (
		<Dialog
			title="Send a raw webhook"
			subtitle="Signed and delivered exactly like a generated event"
			onClose={props.onClose}
			footer={
				<>
					<button type="button" className="button" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" className="button button--primary" onClick={send}>
						Send
					</button>
				</>
			}
		>
			<label className="field">
				<span className="field__label">Payload</span>
				<textarea
					className="textarea"
					rows={16}
					aria-label="Raw webhook payload"
					value={text}
					onChange={event => {
						setText(event.target.value);
					}}
				/>
			</label>
			{error !== null && <p className="composer__error">{error}</p>}
		</Dialog>
	);
}
