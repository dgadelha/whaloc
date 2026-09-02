import type { HandshakeResult, JsonObject } from "@whaloc/shared";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { useAction, useAppState, useDispatch, useToasts } from "../../store/store.tsx";
import { DeliveryRow } from "./delivery-row.tsx";
import { RawWebhookDialog } from "./raw-webhook-dialog.tsx";

const PAGE_SIZE = 50;

function HandshakeResultLine(props: { result: HandshakeResult }) {
	const { result } = props;

	return (
		<span
			className={clsx("badge", result.ok ? "badge--ok" : "badge--danger")}
			title={result.error ?? result.echo ?? ""}
		>
			handshake {result.ok ? "ok" : "failed"}
			{result.status === null ? "" : ` · ${String(result.status)}`}
		</span>
	);
}

/** The webhook target as `GET /api/state` reports it: URL, whether the secrets are set, actions. */
function WebhookTarget(props: { onSendRaw: () => void }) {
	const { server } = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [handshake, setHandshake] = useState<HandshakeResult | null>(server?.webhook.lastHandshake ?? null);
	const [running, setRunning] = useState(false);
	const webhook = server?.webhook;

	return (
		<div className="target">
			{webhook?.url == null ? (
				<span className="badge badge--warn badge--wrap">no WHALOC_WEBHOOK_URL — deliveries are logged, not sent</span>
			) : (
				<div className="target__url">
					<span className="mono">{webhook.url}</span>
				</div>
			)}

			<span className={clsx("badge", webhook?.appSecretConfigured === true ? "badge--ok" : "badge--warn")}>
				{webhook?.appSecretConfigured === true ? "signed" : "unsigned"}
			</span>
			<span className={clsx("badge", webhook?.verifyTokenConfigured === true ? "badge--ok" : "")}>
				verify token {webhook?.verifyTokenConfigured === true ? "set" : "unset"}
			</span>

			{handshake !== null && <HandshakeResultLine result={handshake} />}

			<span className="spacer" />

			<button
				type="button"
				className="button"
				disabled={running}
				onClick={() => {
					setRunning(true);

					void (async () => {
						try {
							setHandshake(await api.runHandshake());

							// The result is remembered in `GET /api/state`; keep the shell in step.
							dispatch({ type: "state/loaded", server: await api.getState() });
						} catch (error) {
							toasts.error(error);
						} finally {
							setRunning(false);
						}
					})();
				}}
			>
				{running ? "verifying…" : "Verify webhook"}
			</button>
			<button type="button" className="button" onClick={props.onSendRaw}>
				Send raw webhook…
			</button>
		</div>
	);
}

/**
 * The delivery log (SPEC §3): every attempt whaloc made, newest first, with the exact bytes it
 * signed. New attempts arrive over `webhook.delivery` and are prepended live — including the
 * ones a redelivery produces.
 */
export function WebhooksPage() {
	const { deliveries, deliveriesBefore } = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [sendingRaw, setSendingRaw] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);

	useEffect(() => {
		const controller = new AbortController();

		async function load(): Promise<void> {
			try {
				const page = await api.listWebhookDeliveries({ limit: PAGE_SIZE }, { signal: controller.signal });

				dispatch({ type: "deliveries/loaded", deliveries: page.data, before: page.paging.before, mode: "latest" });
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		}

		void load();

		return () => {
			controller.abort();
		};
	}, [dispatch, toasts]);

	const loadMore = (): void => {
		if (deliveriesBefore === null) {
			return;
		}

		setLoadingMore(true);

		void (async () => {
			try {
				const page = await api.listWebhookDeliveries({ limit: PAGE_SIZE, before: deliveriesBefore });

				dispatch({ type: "deliveries/loaded", deliveries: page.data, before: page.paging.before, mode: "older" });
			} catch (error) {
				toasts.error(error);
			} finally {
				setLoadingMore(false);
			}
		})();
	};

	const sendRaw = (payload: JsonObject): void => {
		setSendingRaw(false);
		run(async () => api.sendRawWebhook(payload));
	};

	return (
		<div className="page">
			<header className="page__header">
				<div className="page__title">
					<h1>Webhooks</h1>
					<span className="faint">{deliveries === null ? "loading…" : `${String(deliveries.length)} attempts`}</span>
				</div>
			</header>

			<WebhookTarget
				onSendRaw={() => {
					setSendingRaw(true);
				}}
			/>

			<div className="page__body page__body--flush">
				{deliveries?.length === 0 && (
					<p className="empty">
						Nothing delivered yet. Send a message from the app under test, or simulate one from Chats.
					</p>
				)}

				{deliveries !== null && deliveries.length > 0 && (
					<table className="table table--log">
						<thead>
							<tr>
								<th aria-label="Expand" />
								<th>Time</th>
								<th>Event</th>
								<th>Status</th>
								<th>Attempt</th>
								<th>Duration</th>
								<th>URL</th>
							</tr>
						</thead>
						<tbody>
							{deliveries.map(delivery => {
								return <DeliveryRow key={delivery.id} delivery={delivery} />;
							})}
						</tbody>
					</table>
				)}

				{deliveriesBefore !== null && (
					<div className="messages__more">
						<button type="button" className="button button--sm" disabled={loadingMore} onClick={loadMore}>
							{loadingMore ? "loading…" : "Load older attempts"}
						</button>
					</div>
				)}
			</div>

			{sendingRaw && (
				<RawWebhookDialog
					onSend={sendRaw}
					onClose={() => {
						setSendingRaw(false);
					}}
				/>
			)}
		</div>
	);
}
