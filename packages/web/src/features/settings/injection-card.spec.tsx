import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import {
	jsonResponse,
	makeAppState,
	makeInjectionRule,
	requestBodyOf,
	stubFetch,
	type FetchMock,
} from "../../test/factories.ts";
import { InjectionCard } from "./injection-card.tsx";

/**
 * The Settings section that arms and disarms error injection (SPEC §4).
 *
 * What is asserted is the **request body**: the form's job is to turn three dropdowns and a
 * number into the rule the control plane accepts, and everything downstream of that is covered
 * by the server specs.
 */
function renderCard(state: Partial<AppState> = {}): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
			{children}
		</StoreProvider>
	);

	render(<InjectionCard />, { wrapper });
}

describe("InjectionCard", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makeInjectionRule() }, 201)));
	});

	it("says so when nothing is armed", () => {
		renderCard();

		expect(screen.getByText(/No rules armed/)).toBeTruthy();
	});

	it("lists a rule with its live countdown", () => {
		renderCard({ injectionRules: [makeInjectionRule({ seen: 1, matches: 1, remaining: 2 })] });

		expect(screen.getByText("messages.send")).toBeTruthy();
		expect(screen.getByText("rate_limit_429")).toBeTruthy();
		expect(screen.getByText("next 3 — 2 left")).toBeTruthy();
		expect(screen.getByText(/1 fired \/ 1 seen/)).toBeTruthy();
		// The two throttling values the consumer parses are on screen, in their own units.
		expect(screen.getByText(/Retry-After 60s, 15min/)).toBeTruthy();
	});

	it("marks a spent rule instead of hiding it", () => {
		renderCard({ injectionRules: [makeInjectionRule({ remaining: 0, exhausted: true, matches: 3, seen: 3 })] });

		expect(screen.getByText("next 3 — spent")).toBeTruthy();
	});

	it("describes the other two triggers", () => {
		renderCard({
			injectionRules: [
				makeInjectionRule({ trigger: { kind: "always" }, remaining: null }),
				makeInjectionRule({ id: "b", trigger: { kind: "every", nth: 4 }, remaining: null }),
			],
		});

		// `always` is also one of the form's options, so the badges are looked up in the table.
		const table = screen.getByRole("table");

		expect(within(table).getByText("always")).toBeTruthy();
		expect(within(table).getByText("every 4 requests")).toBeTruthy();
	});

	it("counts the armed rules in the card's title", () => {
		renderCard({
			injectionRules: [makeInjectionRule(), makeInjectionRule({ id: "b", remaining: 0, exhausted: true })],
		});

		expect(screen.getByText("1 armed")).toBeTruthy();
	});

	it("arms the default rule with its throttling knobs", async () => {
		renderCard();

		fireEvent.click(screen.getByRole("button", { name: "Arm rule" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe("/api/injection-rules");
		expect(init?.method).toBe("POST");
		expect(requestBodyOf(fetchMock)).toEqual({
			target: "messages.send",
			preset: "rate_limit_429",
			trigger: { kind: "next", count: 3 },
			retryAfterSeconds: 60,
			regainAccessMinutes: 15,
		});
	});

	it("sends the target, preset and trigger the dropdowns were left on", async () => {
		renderCard();

		fireEvent.change(screen.getByLabelText("Rule target"), { target: { value: "media.download" } });
		fireEvent.change(screen.getByLabelText("Rule preset"), { target: { value: "server_error_500" } });
		fireEvent.change(screen.getByLabelText("Rule trigger"), { target: { value: "every" } });
		fireEvent.change(screen.getByLabelText("Trigger count"), { target: { value: "4" } });
		fireEvent.click(screen.getByRole("button", { name: "Arm rule" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			target: "media.download",
			preset: "server_error_500",
			trigger: { kind: "every", nth: 4 },
		});
	});

	it("drops the count from an always trigger, and hides the field", async () => {
		renderCard();

		fireEvent.change(screen.getByLabelText("Rule trigger"), { target: { value: "always" } });
		expect(screen.queryByLabelText("Trigger count")).toBeNull();

		fireEvent.change(screen.getByLabelText("Rule preset"), { target: { value: "throughput_131056" } });
		fireEvent.click(screen.getByRole("button", { name: "Arm rule" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			target: "messages.send",
			preset: "throughput_131056",
			trigger: { kind: "always" },
		});
	});

	it("only offers the throttling fields to the presets that emit those headers", () => {
		renderCard();

		expect(screen.getByLabelText("Retry-After seconds")).toBeTruthy();

		fireEvent.change(screen.getByLabelText("Rule preset"), { target: { value: "spam_rate_4" } });
		expect(screen.getByLabelText("Retry-After seconds")).toBeTruthy();

		fireEvent.change(screen.getByLabelText("Rule preset"), { target: { value: "server_error_500" } });
		expect(screen.queryByLabelText("Retry-After seconds")).toBeNull();
	});

	it("carries the custom envelope when the custom preset is picked", async () => {
		renderCard();

		fireEvent.change(screen.getByLabelText("Rule preset"), { target: { value: "custom" } });
		fireEvent.change(screen.getByLabelText("Rule trigger"), { target: { value: "always" } });
		fireEvent.change(screen.getByLabelText("Custom HTTP status"), { target: { value: "503" } });
		fireEvent.change(screen.getByLabelText("Custom error code"), { target: { value: "2" } });
		fireEvent.change(screen.getByLabelText("Custom error message"), { target: { value: "Service unavailable" } });
		fireEvent.click(screen.getByRole("button", { name: "Arm rule" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			target: "messages.send",
			preset: "custom",
			trigger: { kind: "always" },
			custom: { httpStatus: 503, code: 2, message: "Service unavailable" },
		});
	});

	// The toast is rendered by the shell, so this asserts the thing that matters: nothing went out.
	it("does not post a countdown that is not a whole number", () => {
		renderCard();

		fireEvent.change(screen.getByLabelText("Trigger count"), { target: { value: "many" } });
		fireEvent.click(screen.getByRole("button", { name: "Arm rule" }));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("deletes a rule and drops it from the list", async () => {
		const rule = makeInjectionRule();

		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: rule })));
		renderCard({ injectionRules: [rule] });

		fireEvent.click(screen.getByRole("button", { name: "Delete rule messages.send rate_limit_429" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(`/api/injection-rules/${rule.id}`, expect.anything());
		});

		await waitFor(() => {
			expect(screen.getByText(/No rules armed/)).toBeTruthy();
		});
	});
});
