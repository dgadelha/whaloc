import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import {
	jsonResponse,
	makeAppState,
	makeStateResponse,
	stubFetch,
	WABA_ID,
	type FetchMock,
} from "../../test/factories.ts";
import { DangerZoneCard } from "./danger-zone-card.tsx";

/**
 * The danger zone through the DOM (SPEC §5): export is a link the browser follows, import and
 * reset are two clicks each, and both say what they are about to destroy.
 */
function renderCard(state: Partial<AppState> = {}): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
			{children}
		</StoreProvider>
	);

	render(<DangerZoneCard />, { wrapper });
}

function chooseFile(name = "whaloc-snapshot.json"): void {
	const input = screen.getByLabelText("Snapshot file");
	const file = new File(['{"schemaVersion":1}'], name, { type: "application/json" });

	// jsdom leaves `files` read-only, which is what a real picker would have filled in.
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	fireEvent.change(input);
}

const IMPORTED = {
	summary: {
		schemaVersion: 1,
		whalocVersion: "0.0.0",
		exportedAt: "2026-09-01T12:00:00.000Z",
		counts: {
			wabas: 1,
			phoneNumbers: 1,
			contacts: 2,
			templates: 1,
			messages: 7,
			media: 1,
			uploadSessions: 0,
			webhookDeliveries: 0,
			injectionRules: 0,
			expiredTokens: 0,
		},
		mediaObjects: { restored: 1, missing: 0, bytes: 12 },
	},
	state: makeStateResponse({
		wabas: [{ id: WABA_ID, name: "Imported Business", subscribedAt: null, phoneNumbers: [] }],
	}),
};

describe("DangerZoneCard", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: IMPORTED })));
	});

	it("links straight at the export, so the browser saves the file itself", () => {
		renderCard();

		const link = screen.getByRole("link", { name: "Export state" });

		expect(link.getAttribute("href")).toBe("/api/export");
		expect(link.hasAttribute("download")).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("asks for the delivery log only when the box is ticked", () => {
		renderCard();

		fireEvent.click(screen.getByRole("checkbox"));

		expect(screen.getByRole("link", { name: "Export state" }).getAttribute("href")).toBe(
			"/api/export?include=deliveries",
		);
	});

	it("does not import without a file", () => {
		renderCard();

		fireEvent.click(screen.getByRole("button", { name: "Import state…" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("confirms first, naming the file and warning that the seed is not re-applied", () => {
		renderCard();
		chooseFile("bug-1234.json");
		fireEvent.click(screen.getByRole("button", { name: "Import state…" }));

		const dialog = screen.getByRole("dialog", { name: "Replace all state?" });

		expect(within(dialog).getByText(/bug-1234\.json/)).toBeTruthy();
		// Read off the whole panel: the sentence is broken up by `<code>` and `<strong>`.
		expect(dialog.textContent).toContain("is not re-applied");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uploads the snapshot as multipart and applies what came back", async () => {
		renderCard();
		chooseFile();
		fireEvent.click(screen.getByRole("button", { name: "Import state…" }));
		fireEvent.click(screen.getByRole("button", { name: "Import and replace" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe("/api/import");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBeInstanceOf(FormData);
		expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
		// The dialog closes on success, which is what says the state was replaced.
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("cancels without importing", () => {
		renderCard();
		chooseFile();
		fireEvent.click(screen.getByRole("button", { name: "Import state…" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still resets, behind its own confirmation", async () => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makeStateResponse() })));
		renderCard();

		fireEvent.click(screen.getByRole("button", { name: "Reset whaloc…" }));
		expect(fetchMock).not.toHaveBeenCalled();

		const dialog = screen.getByRole("dialog", { name: "Reset whaloc?" });

		fireEvent.click(within(dialog).getByRole("button", { name: "Reset everything" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith("/api/reset", expect.objectContaining({ method: "POST" }));
		});
	});
});
