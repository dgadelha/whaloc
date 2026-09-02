import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "../store/store.tsx";
import type { AppState } from "../store/types.ts";
import { makeAppState, makeInjectionRule } from "../test/factories.ts";
import { InjectionBadge } from "./injection-badge.tsx";

/**
 * The shell's reminder that whaloc is deliberately failing requests (SPEC §4).
 *
 * The rule it enforces is a small one with a large payoff: a rule nobody can see is a rule that
 * wastes an afternoon, and an *exhausted* rule that still shouted would train people to ignore it.
 */
function renderBadge(state: Partial<AppState> = {}): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter>
			<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
				{children}
			</StoreProvider>
		</MemoryRouter>
	);

	render(<InjectionBadge />, { wrapper });
}

describe("InjectionBadge", () => {
	it("renders nothing when no rule is armed", () => {
		renderBadge();

		expect(screen.queryByRole("link")).toBeNull();
	});

	it("renders nothing before the rules have loaded", () => {
		renderBadge({ injectionRules: null });

		expect(screen.queryByRole("link")).toBeNull();
	});

	it("warns about one armed rule, and links to Settings", () => {
		renderBadge({ injectionRules: [makeInjectionRule()] });

		const link = screen.getByRole("link", { name: "1 rule injecting errors" });

		expect(link.getAttribute("href")).toBe("/settings");
		expect(link.getAttribute("title")).toContain("messages.send");
	});

	it("counts several", () => {
		renderBadge({
			injectionRules: [
				makeInjectionRule(),
				makeInjectionRule({ id: "second", target: "graph.all", trigger: { kind: "always" }, remaining: null }),
			],
		});

		expect(screen.getByRole("link", { name: "2 rules injecting errors" })).toBeTruthy();
	});

	it("ignores a spent next-N rule: it cannot fire again", () => {
		renderBadge({ injectionRules: [makeInjectionRule({ remaining: 0, exhausted: true, matches: 3, seen: 3 })] });

		expect(screen.queryByRole("link")).toBeNull();
	});

	it("still warns when only one of the listed rules is armed", () => {
		renderBadge({
			injectionRules: [
				makeInjectionRule({ remaining: 0, exhausted: true }),
				makeInjectionRule({ id: "second", target: "media.upload" }),
			],
		});

		expect(screen.getByRole("link", { name: "1 rule injecting errors" })).toBeTruthy();
	});
});
