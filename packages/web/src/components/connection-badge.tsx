import clsx from "clsx";
import type { ConnectionStatus } from "../api/ws-client.ts";
import { useAppState } from "../store/store.tsx";

const LABELS: Record<ConnectionStatus, string> = {
	connecting: "connecting…",
	open: "live",
	closed: "disconnected",
};

const TITLES: Record<ConnectionStatus, string> = {
	connecting: "Opening the control-plane WebSocket",
	open: "Streaming changes from /api/ws",
	closed: "The WebSocket dropped — reconnecting with backoff",
};

/** Green / amber / red: whether what is on screen is still following the server. */
export function ConnectionBadge() {
	const { connection } = useAppState();

	return (
		<span className={clsx("connection", `connection--${connection}`)} title={TITLES[connection]}>
			<span className="connection__dot" aria-hidden="true" />
			<span>{LABELS[connection]}</span>
		</span>
	);
}
