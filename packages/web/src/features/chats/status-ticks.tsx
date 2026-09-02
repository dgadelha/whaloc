import type { JsonObject, MessageStatus } from "@whaloc/shared";
import clsx from "clsx";
import { asNumber, asString } from "../../lib/json.ts";

export interface StatusTicksProps {
	status: MessageStatus;
	/** Meta's `errors[]` node on a failed message; shown as the tick's tooltip. */
	error?: JsonObject | null;
}

const LABELS: Record<MessageStatus, string> = {
	accepted: "accepted — whaloc took the send, no status webhook yet",
	sent: "sent",
	delivered: "delivered",
	read: "read",
	failed: "failed",
};

function Check(props: { double: boolean }) {
	return (
		<svg viewBox="0 0 18 12" width="17" height="12" aria-hidden="true" focusable="false">
			<polyline
				points={props.double ? "1,7 4,10 10,2" : "4,7 7,10 13,2"}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{props.double && (
				<polyline
					points="7,7 10,10 17,2"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.6"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			)}
		</svg>
	);
}

function Clock() {
	return (
		<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
			<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
			<polyline points="6,3 6,6 8,7.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
		</svg>
	);
}

/** The error a failed message carries, as one line for the tooltip. */
export function describeMessageError(error: JsonObject | null | undefined): string | undefined {
	if (!error) {
		return undefined;
	}

	const code = asNumber(error["code"]);
	const title = asString(error["title"]) ?? asString(error["message"]) ?? "delivery failed";

	return code === null ? title : `(#${String(code)}) ${title}`;
}

/**
 * The marker on an **inbound** bubble once the business has read it (SPEC §2.18).
 *
 * It is deliberately not the outbound tick: this direction has no status ladder, only the one
 * fact that the app under test called `POST /{phoneNumberId}/messages` with `status: "read"`.
 * A faint double check says that without pretending the message was ever `sent`.
 */
export function ReadMarker() {
	return (
		<span
			className="ticks ticks--read-receipt"
			role="img"
			aria-label="read by the business"
			title="read by the business"
		>
			<Check double />
		</span>
	);
}

/**
 * The tick a WhatsApp user reads a status off (SPEC §4): a clock while whaloc has only
 * accepted the send, one check for `sent`, two for `delivered`, two in colour for `read`, and
 * a cross carrying the error for `failed`.
 */
export function StatusTicks(props: StatusTicksProps) {
	const failure = props.status === "failed" ? describeMessageError(props.error) : undefined;

	return (
		<span
			className={clsx("ticks", `ticks--${props.status}`)}
			data-status={props.status}
			role="img"
			aria-label={props.status}
			title={failure ?? LABELS[props.status]}
		>
			{props.status === "accepted" && <Clock />}
			{props.status === "sent" && <Check double={false} />}
			{(props.status === "delivered" || props.status === "read") && <Check double />}
			{props.status === "failed" && <span aria-hidden="true">✕</span>}
		</span>
	);
}
