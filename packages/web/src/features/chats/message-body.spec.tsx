import type { MessageType } from "@whaloc/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import { makeAppState, makeMessage } from "../../test/factories.ts";
import { MessageBody } from "./message-body.tsx";

function renderLinked(type: MessageType, node: Record<string, unknown>): void {
	render(
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			<MessageBody message={makeMessage({ type, payload: { [type]: node } })} />
		</StoreProvider>,
	);
}

describe("media sent by link", () => {
	it.each([
		["image", "img.media__image"],
		["sticker", "img.media__sticker"],
		["video", "video.media__video"],
		["audio", "audio.media__audio"],
	] as const)("renders a linked %s inline", (type, selector) => {
		renderLinked(type, { link: `https://cdn.test/${type}` });

		expect(document.querySelector(selector)?.getAttribute("src")).toBe(`https://cdn.test/${type}`);
	});

	it("keeps a linked document a link", () => {
		renderLinked("document", { link: "https://cdn.test/invoice.pdf", filename: "invoice.pdf" });

		expect(screen.getByRole("link", { name: "invoice.pdf" }).getAttribute("href")).toBe("https://cdn.test/invoice.pdf");
	});
});
