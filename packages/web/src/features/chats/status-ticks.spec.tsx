import { MESSAGE_STATUSES } from "@whaloc/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeMessageError, StatusTicks } from "./status-ticks.tsx";

/** The tick is the whole status ladder as a user sees it, so each rung gets its own check. */
describe("StatusTicks", () => {
	it.each(MESSAGE_STATUSES)("labels %s for assistive technology", status => {
		render(<StatusTicks status={status} />);

		expect(screen.getByRole("img", { name: status })).toBeTruthy();
	});

	it("shows a clock while whaloc has only accepted the send", () => {
		render(<StatusTicks status="accepted" />);

		const ticks = screen.getByRole("img", { name: "accepted" });

		expect(ticks.querySelectorAll("circle")).toHaveLength(1);
		expect(ticks.querySelectorAll("polyline")).toHaveLength(1);
	});

	it("shows one check for sent and two for delivered", () => {
		const { unmount } = render(<StatusTicks status="sent" />);

		expect(screen.getByRole("img", { name: "sent" }).querySelectorAll("polyline")).toHaveLength(1);
		unmount();

		render(<StatusTicks status="delivered" />);
		expect(screen.getByRole("img", { name: "delivered" }).querySelectorAll("polyline")).toHaveLength(2);
	});

	it("colours the double check once the message is read", () => {
		render(<StatusTicks status="read" />);

		const ticks = screen.getByRole("img", { name: "read" });

		expect(ticks.querySelectorAll("polyline")).toHaveLength(2);
		expect(ticks.className).toContain("ticks--read");
	});

	it("carries the error as the tooltip of a failed message", () => {
		render(
			<StatusTicks
				status="failed"
				error={{ code: 131_049, title: "This message was not delivered to maintain healthy ecosystem engagement." }}
			/>,
		);

		const ticks = screen.getByRole("img", { name: "failed" });

		expect(ticks.getAttribute("title")).toBe(
			"(#131049) This message was not delivered to maintain healthy ecosystem engagement.",
		);
		expect(ticks.className).toContain("ticks--failed");
	});

	it("still says something when a failure carries no error node", () => {
		render(<StatusTicks status="failed" error={null} />);

		expect(screen.getByRole("img", { name: "failed" }).getAttribute("title")).toBe("failed");
	});
});

describe("describeMessageError", () => {
	it("falls back to the message when there is no title", () => {
		expect(describeMessageError({ code: 131_026, message: "Message undeliverable" })).toBe(
			"(#131026) Message undeliverable",
		);
	});

	it("has nothing to say about a message that did not fail", () => {
		expect(describeMessageError(null)).toBeUndefined();
	});
});
