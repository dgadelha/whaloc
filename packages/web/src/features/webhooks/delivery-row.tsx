import type { WebhookDelivery } from "@whaloc/shared";
import clsx from "clsx";
import { useState } from "react";
import { api } from "../../api/endpoints.ts";
import { JsonBlock } from "../../components/json-block.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatClockWithSeconds, formatDuration } from "../../lib/format.ts";
import { prettyJsonText } from "../../lib/json.ts";
import { useAction, useToasts } from "../../store/store.tsx";

export interface DeliveryOutcome {
	label: string;
	tone: string;
}

/**
 * What the row's status cell says. A delivery with no URL configured was never sent — the
 * payload is logged anyway (SPEC §3) — and that is a different thing from a request that
 * failed, so it gets its own label rather than an empty status.
 */
export function describeOutcome(delivery: WebhookDelivery): DeliveryOutcome {
	if (delivery.skipped) {
		return { label: "skipped", tone: "" };
	}

	if (delivery.responseStatus === null) {
		return { label: "error", tone: "badge--danger" };
	}

	if (delivery.responseStatus >= 500) {
		return { label: String(delivery.responseStatus), tone: "badge--danger" };
	}

	if (delivery.responseStatus >= 400) {
		return { label: String(delivery.responseStatus), tone: "badge--warn" };
	}

	return { label: String(delivery.responseStatus), tone: "badge--ok" };
}

export interface DeliveryRowProps {
	delivery: WebhookDelivery;
}

/** One attempt in the delivery log, expandable into the exact bytes that went out. */
export function DeliveryRow(props: DeliveryRowProps) {
	const { delivery } = props;
	const [open, setOpen] = useState(false);
	const run = useAction();
	const toasts = useToasts();
	const outcome = describeOutcome(delivery);

	return (
		<>
			<tr
				className={clsx("delivery", open && "is-open")}
				onClick={() => {
					setOpen(!open);
				}}
			>
				<td>
					<button
						type="button"
						className="link-button"
						aria-expanded={open}
						aria-label={`Toggle delivery ${delivery.id}`}
					>
						{open ? "▾" : "▸"}
					</button>
				</td>
				<td className="faint mono">{formatClockWithSeconds(delivery.createdAt)}</td>
				<td>
					<span className="chip">{delivery.eventType}</span>
				</td>
				<td>
					<span className={clsx("badge", outcome.tone)}>{outcome.label}</span>
				</td>
				<td className="faint">#{delivery.attempt}</td>
				<td className="faint">{formatDuration(delivery.durationMs)}</td>
				<td className="faint mono delivery__url">{delivery.url === "" ? "—" : delivery.url}</td>
			</tr>

			{open && (
				<tr className="delivery__details">
					<td colSpan={7}>
						<div className="stack">
							{delivery.error !== null && <p className="composer__error">{delivery.error}</p>}

							<div className="row row--wrap">
								<button
									type="button"
									className="button button--sm"
									onClick={event => {
										event.stopPropagation();
										run(async () => api.redeliverWebhook(delivery.id));
									}}
								>
									Redeliver
								</button>
								<button
									type="button"
									className="button button--sm"
									onClick={event => {
										event.stopPropagation();

										void (async () => {
											const result = await copyToClipboard(delivery.requestBody);

											toasts.info(result === "copied" ? "Request body copied" : "The clipboard is not available here");
										})();
									}}
								>
									Copy body
								</button>
							</div>

							<section>
								<h3 className="card__title">Request headers</h3>
								<JsonBlock value={delivery.requestHeaders} />
							</section>

							<section>
								<h3 className="card__title">Request body</h3>
								<JsonBlock text={prettyJsonText(delivery.requestBody)} />
							</section>

							{delivery.responseBody !== null && (
								<section>
									<h3 className="card__title">Response body</h3>
									<JsonBlock text={prettyJsonText(delivery.responseBody)} />
								</section>
							)}
						</div>
					</td>
				</tr>
			)}
		</>
	);
}
