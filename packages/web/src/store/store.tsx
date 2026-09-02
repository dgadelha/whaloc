import { createContext, use, useCallback, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { describeError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import { connectEvents } from "../api/ws-client.ts";
import { initialState, reducer } from "./reducer.ts";
import type { Action, AppState, Toast } from "./types.ts";

/**
 * The store: `useReducer` behind a context, plus the two effects that fill it — one REST
 * bootstrap and one WebSocket subscription.
 *
 * There is no data-fetching library here on purpose. Nothing in this UI polls or re-fetches on
 * focus: the server pushes every change over `/api/ws`, so the cache-invalidation half of a
 * query library would sit unused while its bundle would not. What is left — "load once, then
 * fold events in" — is the reducer next door, which is also what makes the merge rules
 * testable without rendering anything.
 */

interface Store {
	state: AppState;
	dispatch: (action: Action) => void;
}

const StoreContext = createContext<Store | null>(null);

/** Toast ids only have to be unique within a session; nothing links to them. */
function nextToastId(): string {
	return `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface StoreProviderProps {
	children: ReactNode;
	/** Tests mount the provider with a state of their own instead of letting it load one. */
	preloadedState?: AppState;
	/** Disables the bootstrap and the socket; used by component tests. */
	isLive?: boolean;
}

export function StoreProvider(props: StoreProviderProps) {
	const [state, dispatch] = useReducer(reducer, props.preloadedState ?? initialState);
	const isLive = props.isLive ?? true;

	useEffect(() => {
		if (!isLive) {
			return;
		}

		const controller = new AbortController();
		const signal = controller.signal;

		async function bootstrap(): Promise<void> {
			try {
				// The injection rules load here rather than in the view that manages them: a
				// forgotten rule has to show up in the shell's badge from the first frame,
				// whether or not anyone opens Settings (SPEC §4).
				const [server, contacts, errorPresets, injectionRules] = await Promise.all([
					api.getState({ signal }),
					api.listContacts({ signal }),
					api.listMessageErrorPresets({ signal }),
					api.listInjectionRules({ signal }),
				]);

				dispatch({ type: "bootstrap/loaded", server, contacts, errorPresets, injectionRules });
			} catch (error) {
				if (!signal.aborted) {
					dispatch({ type: "bootstrap/failed", message: describeError(error) });
				}
			}
		}

		void bootstrap();

		return () => {
			controller.abort();
		};
	}, [isLive]);

	useEffect(() => {
		if (!isLive) {
			return;
		}

		let hasConnected = false;

		/**
		 * The collections that are loaded **once** and then kept current by events: after a wipe
		 * there are no events to keep them current with, so they are re-read. A reset brings the
		 * seed's contacts back and an import brings a stranger's — including injection rules and
		 * expired tokens this client has never seen (SPEC §5).
		 */
		async function reloadAfterWipe(): Promise<void> {
			const [contacts, injectionRules, tokens] = await Promise.all([
				api.listContacts(),
				api.listInjectionRules(),
				api.listTokens(),
			]);

			dispatch({ type: "contacts/loaded", contacts });
			dispatch({ type: "injection-rules/loaded", rules: injectionRules });
			dispatch({ type: "tokens/loaded", tokens: tokens.data });
		}

		return connectEvents({
			onEvent: event => {
				dispatch({ type: "ws/event", event });

				if (event.type === "state.reset" || event.type === "state.imported") {
					void reloadAfterWipe().catch(() => {
						// Whoever pressed the button gets the error; a toast in every other tab for
						// something nobody there asked for is noise.
					});
				}
			},
			onStatus: connection => {
				dispatch({ type: "connection/changed", connection });

				if (connection !== "open") {
					return;
				}

				// A *re*connect means events were missed while the socket was down — a WABA or a
				// phone number could have come or gone. Re-reading the snapshot is the cheapest
				// way to be right again, and it is the only fetch this UI makes on its own.
				if (hasConnected) {
					void api
						.getState()
						.then(server => {
							dispatch({ type: "state/loaded", server });
						})
						.catch(() => {
							// The socket is back but the REST call failed: the next reconnect
							// tries again, and a toast for something nobody asked for is noise.
						});
				}

				hasConnected = true;
			},
		});
	}, [isLive]);

	const store = useMemo<Store>(() => ({ state, dispatch }), [state]);

	return <StoreContext value={store}>{props.children}</StoreContext>;
}

function useStore(): Store {
	const store = use(StoreContext);

	if (store === null) {
		throw new Error("useStore must be used inside <StoreProvider>");
	}

	return store;
}

export function useAppState(): AppState {
	return useStore().state;
}

export function useDispatch(): (action: Action) => void {
	return useStore().dispatch;
}

export interface ToastApi {
	error: (error: unknown) => void;
	info: (message: string) => void;
	dismiss: (id: string) => void;
}

export function useToasts(): ToastApi {
	const dispatch = useDispatch();

	return useMemo<ToastApi>(() => {
		return {
			error: error => {
				const toast: Toast = { id: nextToastId(), kind: "error", message: describeError(error) };

				dispatch({ type: "toast/pushed", toast });
			},
			info: message => {
				dispatch({ type: "toast/pushed", toast: { id: nextToastId(), kind: "info", message } });
			},
			dismiss: id => {
				dispatch({ type: "toast/dismissed", id });
			},
		};
	}, [dispatch]);
}

/**
 * Runs an action against the API and turns any failure into a toast. Every button in the UI
 * goes through this, which is why no component has a try/catch of its own.
 */
export function useAction(): (run: () => Promise<unknown>) => void {
	const toasts = useToasts();

	return useCallback(
		(run: () => Promise<unknown>) => {
			void run().catch((error: unknown) => {
				toasts.error(error);
			});
		},
		[toasts],
	);
}
