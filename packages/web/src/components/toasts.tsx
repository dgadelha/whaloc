import clsx from "clsx";
import { useEffect } from "react";
import { useAppState, useToasts } from "../store/store.tsx";

const DISMISS_AFTER_MS = 8000;

/** Where every failed API call ends up: one line, dismissible, gone on its own after a while. */
export function Toasts() {
	const { toasts } = useAppState();
	const { dismiss } = useToasts();

	useEffect(() => {
		const timers = toasts.map(toast => {
			return setTimeout(() => {
				dismiss(toast.id);
			}, DISMISS_AFTER_MS);
		});

		return () => {
			for (const timer of timers) {
				clearTimeout(timer);
			}
		};
	}, [toasts, dismiss]);

	if (toasts.length === 0) {
		return null;
	}

	return (
		<div className="toasts" role="status" aria-live="polite">
			{toasts.map(toast => (
				<div key={toast.id} className={clsx("toast", toast.kind === "error" && "toast--error")}>
					<span className="toast__message">{toast.message}</span>
					<button
						type="button"
						className="button button--ghost button--icon"
						aria-label="Dismiss"
						onClick={() => {
							dismiss(toast.id);
						}}
					>
						✕
					</button>
				</div>
			))}
		</div>
	);
}
