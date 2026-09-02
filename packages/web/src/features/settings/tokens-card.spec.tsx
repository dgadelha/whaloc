import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsPage } from "./settings-page.tsx";
import { StoreProvider } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import {
	jsonResponse,
	makeAppState,
	makeStateResponse,
	makeToken,
	stubFetch,
	type FetchMock,
} from "../../test/factories.ts";
import { TokensCard } from "./tokens-card.tsx";

/**
 * The token registry in Settings (SPEC §1.9).
 *
 * Two properties are load-bearing: the section does not exist unless `WHALOC_TOKENS` is set, and
 * the token value never reaches the browser.
 */
function renderWith(node: ReactNode, state: Partial<AppState> = {}): void {
	render(
		<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
			{node}
		</StoreProvider>,
	);
}

const TOKENS = [
	makeToken({ id: "aaaa000000000000", masked: "••••••••-one", last4: "-one" }),
	makeToken({
		id: "bbbb000000000000",
		masked: "••••••••-two",
		last4: "-two",
		expired: true,
		expiredAt: "2026-09-01T10:00:00.000Z",
	}),
];

describe("TokensCard", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ strict: true, data: TOKENS })));
	});

	it("loads the registry and shows each token masked", async () => {
		renderWith(<TokensCard />);

		await waitFor(() => {
			expect(screen.getByText("••••••••-one")).toBeTruthy();
		});

		expect(fetchMock).toHaveBeenCalledWith("/api/tokens", expect.anything());
		expect(screen.getByText("••••••••-two")).toBeTruthy();
		expect(screen.getByText("valid")).toBeTruthy();
		expect(screen.getByText("expired")).toBeTruthy();
	});

	it("expires a valid token", async () => {
		renderWith(<TokensCard />, { tokens: TOKENS });

		fireEvent.click(screen.getByRole("button", { name: "Expire token -one" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(`/api/tokens/${TOKENS[0]!.id}/expire`, expect.anything());
		});
	});

	it("restores an expired one", async () => {
		renderWith(<TokensCard />, { tokens: TOKENS });

		fireEvent.click(screen.getByRole("button", { name: "Restore token -two" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(`/api/tokens/${TOKENS[1]!.id}/restore`, expect.anything());
		});
	});
});

describe("SettingsPage token section", () => {
	beforeEach(() => {
		stubFetch(() => Promise.resolve(jsonResponse({ strict: true, data: TOKENS })));
	});

	it("is absent while WHALOC_TOKENS is unset", () => {
		renderWith(<SettingsPage />);

		expect(screen.queryByRole("heading", { name: "Access tokens" })).toBeNull();
		expect(screen.getByText("any non-empty bearer token")).toBeTruthy();
	});

	it("appears once the server reports a registry", async () => {
		renderWith(<SettingsPage />, {
			server: makeStateResponse({
				behavior: {
					statusDelays: { sent: 0, delivered: 800, read: null },
					templateAutoApproveMs: 2000,
					strictTokens: true,
					mediaTtlSeconds: 5,
				},
			}),
		});

		expect(screen.getByRole("heading", { name: "Access tokens" })).toBeTruthy();
		expect(screen.getByText("only the registered tokens are accepted")).toBeTruthy();
		expect(screen.getByText(/5 s, then 400 \/ code 100 \/ subcode 33/)).toBeTruthy();

		await waitFor(() => {
			expect(screen.getByText("••••••••-one")).toBeTruthy();
		});
	});
});
