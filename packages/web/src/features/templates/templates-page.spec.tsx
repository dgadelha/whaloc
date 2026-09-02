import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import { jsonResponse, makeAppState, makeTemplate, stubFetch, WABA_ID, type FetchMock } from "../../test/factories.ts";
import { TemplatesPage } from "./templates-page.tsx";

/**
 * The templates filter bar (SPEC §2.8).
 *
 * It is **server-side**: every change re-asks `GET /api/templates` with the filters as query
 * parameters, so the page shows the same set a consumer's filtered
 * `GET /{wabaId}/message_templates` would. These tests are about the requests that go out.
 *
 * Every one of them carries the WABA the shell is scoped to: templates belong to an account, and
 * the breadcrumb's account segment is the whole scope this view has.
 */
function templatesPath(filters?: string): string {
	return `/api/templates?wabaId=${WABA_ID}${filters === undefined ? "" : `&${filters}`}`;
}

function renderTemplates(templates = [makeTemplate()]): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState({ templates })}>
			{children}
		</StoreProvider>
	);

	render(<TemplatesPage />, { wrapper });
}

/** The paths the mock was asked for, in order. */
function paths(mock: FetchMock): string[] {
	return mock.mock.calls.map(([path]) => path);
}

describe("TemplatesPage filters", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: [makeTemplate()] })));
	});

	it("loads the unfiltered listing first", async () => {
		renderTemplates();

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(paths(fetchMock)).toEqual([templatesPath()]);
	});

	it("asks the server for the status and category the bar selected", async () => {
		renderTemplates();

		fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "APPROVED" } });
		fireEvent.change(screen.getByLabelText("Filter by category"), { target: { value: "MARKETING" } });

		await waitFor(() => {
			expect(paths(fetchMock).at(-1)).toBe(templatesPath(`status=APPROVED&category=MARKETING`));
		});
	});

	it("sends a search as name_or_content, debounced into one request", async () => {
		renderTemplates();

		const search = screen.getByLabelText("Search templates by name or content");

		fireEvent.change(search, { target: { value: "ord" } });
		fireEvent.change(search, { target: { value: "orde" } });
		fireEvent.change(search, { target: { value: "order" } });

		await waitFor(() => {
			expect(paths(fetchMock).at(-1)).toBe(templatesPath("search=order"));
		});

		// One request for the whole burst — the keystrokes in between never reached the server,
		// and neither did the unfiltered load they interrupted.
		expect(paths(fetchMock).filter(path => path.includes("search="))).toHaveLength(1);
	});

	it("treats a blank search as no filter at all", async () => {
		renderTemplates();

		fireEvent.change(screen.getByLabelText("Search templates by name or content"), {
			target: { value: " ".repeat(3) },
		});

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(paths(fetchMock)).toEqual([templatesPath()]);
	});

	it("offers to clear a filter that matched nothing", async () => {
		renderTemplates([]);

		fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "REJECTED" } });

		expect(screen.getByText(/No templates match this filter/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Clear it" }));

		expect(screen.getByLabelText("Filter by status")).toHaveProperty("value", "");

		await waitFor(() => {
			expect(paths(fetchMock).at(-1)).toBe(templatesPath());
		});
	});

	it("says what a cold whaloc has instead when nothing is filtered", () => {
		renderTemplates([]);

		expect(screen.getByText(/No templates yet/)).toBeTruthy();
	});
});
