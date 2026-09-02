import type { Message } from "@whaloc/shared";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { useAction, useAppState, useToasts } from "../../store/store.tsx";

export interface MessageActionsProps {
	message: Message;
	onReply: (message: Message) => void;
	onReact: (message: Message) => void;
}

/**
 * What a Meta reviewer would never let you do: move an outbound message along the status
 * ladder by hand (SPEC §4). `delivered` is offered only while the message is still `sent` —
 * with the default delays it gets there on its own — and `failed` opens the presets the
 * control plane accepts, so the app under test receives a real `errors[]` node.
 *
 * The two composer actions live here too: replying to (or reacting to) a business message is
 * how the user side of a conversation actually behaves. Both directions get the menu — an
 * inbound wamid is what a mark-as-read or reaction call needs — but the status ladder is
 * outbound-only, since Meta reports statuses for business messages alone.
 */
export function MessageActions(props: MessageActionsProps) {
	const { message } = props;
	const { errorPresets } = useAppState();
	const run = useAction();
	const toasts = useToasts();
	const [open, setOpen] = useState(false);
	const container = useRef<HTMLDivElement>(null);
	const isOutbound = message.direction === "outbound";

	useEffect(() => {
		if (!open) {
			return;
		}

		const onPointerDown = (event: MouseEvent): void => {
			if (container.current !== null && !container.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};

		globalThis.addEventListener("mousedown", onPointerDown);

		return () => {
			globalThis.removeEventListener("mousedown", onPointerDown);
		};
	}, [open]);

	const act = (perform: () => Promise<unknown>): void => {
		setOpen(false);
		run(perform);
	};

	const canDeliver = message.status === "accepted" || message.status === "sent";
	const canRead = message.status !== "read" && message.status !== "failed";
	const canFail = message.status !== "failed";

	return (
		<div className="actions" ref={container}>
			<button
				type="button"
				className="button button--ghost button--icon actions__toggle"
				aria-label="Message actions"
				aria-expanded={open}
				onClick={() => {
					setOpen(!open);
				}}
			>
				⋯
			</button>

			{open && (
				<div className={clsx("actions__menu", isOutbound ? "actions__menu--end" : "actions__menu--start")} role="menu">
					<button
						type="button"
						role="menuitem"
						className="actions__item"
						onClick={() => {
							setOpen(false);
							void (async () => {
								const result = await copyToClipboard(message.id);

								toasts.info(result === "copied" ? "Message ID copied" : "Clipboard unavailable");
							})();
						}}
					>
						Copy message ID
					</button>
					<button
						type="button"
						role="menuitem"
						className="actions__item"
						onClick={() => {
							setOpen(false);
							props.onReply(message);
						}}
					>
						Reply to this
					</button>
					<button
						type="button"
						role="menuitem"
						className="actions__item"
						onClick={() => {
							setOpen(false);
							props.onReact(message);
						}}
					>
						React…
					</button>

					{isOutbound && (
						<>
							<div className="actions__separator" />

							<button
								type="button"
								role="menuitem"
								className="actions__item"
								disabled={!canDeliver}
								onClick={() => {
									act(async () => api.setMessageStatus(message.id, { status: "delivered" }));
								}}
							>
								Mark delivered
							</button>
							<button
								type="button"
								role="menuitem"
								className="actions__item"
								disabled={!canRead}
								onClick={() => {
									act(async () => api.setMessageStatus(message.id, { status: "read" }));
								}}
							>
								Mark read
							</button>

							<div className="actions__separator" />
							<span className="actions__label">Fail as…</span>
							{errorPresets.map(preset => (
								<button
									key={preset.code}
									type="button"
									role="menuitem"
									className="actions__item actions__item--danger"
									disabled={!canFail}
									title={preset.details}
									onClick={() => {
										act(async () => api.setMessageStatus(message.id, { status: "failed", errorCode: preset.code }));
									}}
								>
									#{preset.code} {preset.title}
								</button>
							))}
						</>
					)}
				</div>
			)}
		</div>
	);
}
