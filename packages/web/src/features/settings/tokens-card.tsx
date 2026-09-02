import type { TokenState } from "@whaloc/shared";
import clsx from "clsx";
import { useEffect } from "react";
import { api } from "../../api/endpoints.ts";
import { formatTimestamp } from "../../lib/format.ts";
import { useAction, useAppState, useDispatch, useToasts } from "../../store/store.tsx";

/**
 * The bearer tokens `WHALOC_TOKENS` registers (SPEC §1.9).
 *
 * The card is **not rendered at all** unless the variable is set: with no registry there is
 * nothing to list and no expiry to simulate, and a section explaining an absent feature is just
 * a section a reader has to skip. `behavior.strictTokens` in `GET /api/state` is the switch.
 *
 * Tokens are shown masked, and the value is never served to the browser — the point of the card
 * is to *invalidate* a token whose value the developer already has in a compose file.
 */
function TokenRow(props: { token: TokenState }) {
	const { token } = props;
	const run = useAction();

	return (
		<tr>
			<td className="mono">{token.masked}</td>
			<td>
				<span className={clsx("badge", token.expired ? "badge--danger" : "badge--ok")}>
					{token.expired ? "expired" : "valid"}
				</span>
			</td>
			<td className="faint">{token.expiredAt === null ? "—" : `since ${formatTimestamp(token.expiredAt)}`}</td>
			<td>
				<button
					type="button"
					className={clsx("button", !token.expired && "button--danger")}
					aria-label={`${token.expired ? "Restore" : "Expire"} token ${token.last4}`}
					onClick={() => {
						run(async () => api.setTokenExpired(token.id, !token.expired));
					}}
				>
					{token.expired ? "Restore" : "Expire"}
				</button>
			</td>
		</tr>
	);
}

export function TokensCard() {
	const { tokens } = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();

	useEffect(() => {
		const controller = new AbortController();
		const load = async (): Promise<void> => {
			try {
				const { data } = await api.listTokens({ signal: controller.signal });

				dispatch({ type: "tokens/loaded", tokens: data });
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		};

		void load();

		return () => {
			controller.abort();
		};
	}, [dispatch, toasts]);

	return (
		<div className="card stack">
			<p className="muted">
				<code>WHALOC_TOKENS</code> is set, so the Graph surface accepts <strong>only</strong> these tokens — anything
				else is <code>401</code> / code <code>190</code>. Expire one to make it answer code <code>190</code> subcode{" "}
				<code>463</code> instead, which is the envelope a consumer keys "refresh my token" on.
			</p>

			{tokens === null ? (
				<p className="empty">loading…</p>
			) : (
				<table className="table">
					<thead>
						<tr>
							<th>Token</th>
							<th>State</th>
							<th>Expired</th>
							<th aria-label="Actions" />
						</tr>
					</thead>
					<tbody>
						{tokens.map(token => (
							<TokenRow key={token.id} token={token} />
						))}
					</tbody>
				</table>
			)}

			<p className="faint">
				Expiry is stored, so it survives a restart when <code>WHALOC_DB_PATH</code> points at a file;{" "}
				<code>POST /api/reset</code> makes every token valid again.
			</p>
		</div>
	);
}
