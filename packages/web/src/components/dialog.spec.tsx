import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./dialog.tsx";

/**
 * The focus contract every dialog inherits: in on open, kept inside while open, back on close.
 *
 * jsdom does not move focus on Tab, so these press Tab on the focused element and assert where
 * the dialog's own handler put it; a Tab the handler lets through leaves focus where it was.
 */
function Opener(props: { children?: ReactNode }) {
	const [open, setOpen] = useState(false);

	return (
		<>
			<button
				type="button"
				onClick={() => {
					setOpen(true);
				}}
			>
				Open
			</button>
			{open && (
				<Dialog
					title="Example"
					onClose={() => {
						setOpen(false);
					}}
					footer={<button type="button">Save</button>}
				>
					{props.children}
				</Dialog>
			)}
		</>
	);
}

/** Presses Tab and returns whether the dialog cancelled it, i.e. took over moving focus itself. */
function didCancelTab(isShifted = false): boolean {
	return !fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey: isShifted });
}

/** The list menu's shape: picking a row closes the dialog and disables the opener until the reply settles. */
function PendingOpener() {
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);

	return (
		<>
			<button
				type="button"
				disabled={pending}
				onClick={() => {
					setOpen(true);
				}}
			>
				Open
			</button>
			<button
				type="button"
				onClick={() => {
					setPending(false);
				}}
			>
				Settle
			</button>
			{open && (
				<Dialog
					title="Example"
					onClose={() => {
						setOpen(false);
					}}
				>
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							setPending(true);
						}}
					>
						Row
					</button>
				</Dialog>
			)}
		</>
	);
}

describe("Dialog", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("focuses the first focusable element after Close on open", () => {
		render(
			<Dialog title="Example" onClose={vi.fn()}>
				<input aria-label="Name" />
			</Dialog>,
		);

		expect(document.activeElement).toBe(screen.getByLabelText("Name"));
	});

	it("focuses Close on open when it is the only focusable element", () => {
		render(
			<Dialog title="Example" onClose={vi.fn()}>
				<p>Nothing else to press.</p>
			</Dialog>,
		);

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
	});

	it("focuses the panel itself when nothing in it is focusable", () => {
		// The header's close button is always focusable, so the empty case is only reachable by
		// hiding every candidate from the lookup.
		const lookup = vi
			.spyOn(Element.prototype, "querySelectorAll")
			.mockReturnValue(document.createDocumentFragment().querySelectorAll("*"));

		render(
			<Dialog title="Example" onClose={vi.fn()}>
				<p>Nothing to press.</p>
			</Dialog>,
		);
		lookup.mockRestore();

		expect(document.activeElement).toBe(screen.getByRole("dialog"));
	});

	it("leaves focus alone when a child already took it", () => {
		render(
			<Dialog title="Example" onClose={vi.fn()}>
				<input aria-label="Name" />
				<input aria-label="Email" autoFocus />
			</Dialog>,
		);

		expect(document.activeElement).toBe(screen.getByLabelText("Email"));
	});

	it("wraps Tab from the last element to the first", () => {
		render(<Opener />);
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		screen.getByRole("button", { name: "Save" }).focus();

		expect(didCancelTab()).toBe(true);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
	});

	it("wraps Shift+Tab from the first element to the last", () => {
		render(<Opener />);
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		screen.getByRole("button", { name: "Close" }).focus();

		expect(didCancelTab(true)).toBe(true);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
	});

	it("lets Tab through between the ends", () => {
		render(
			<Opener>
				<input aria-label="Name" />
			</Opener>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		screen.getByLabelText("Name").focus();

		expect(didCancelTab()).toBe(false);
		expect(didCancelTab(true)).toBe(false);
	});

	it("hands focus back to the opener on close", () => {
		render(<Opener />);

		const open = screen.getByRole("button", { name: "Open" });

		open.focus();
		fireEvent.click(open);

		expect(document.activeElement).not.toBe(open);

		fireEvent.keyDown(document.body, { key: "Escape" });

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(open);
	});

	it("hands focus back to an opener disabled on close once it is enabled again", async () => {
		render(<PendingOpener />);

		const open = screen.getByRole("button", { name: "Open" });

		open.focus();
		fireEvent.click(open);
		fireEvent.click(screen.getByRole("button", { name: "Row" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(open).toHaveProperty("disabled", true);

		// fireEvent does not move focus, so the click stands in for the request settling.
		fireEvent.click(screen.getByRole("button", { name: "Settle" }));

		await waitFor(() => {
			expect(document.activeElement).toBe(open);
		});
	});
});
