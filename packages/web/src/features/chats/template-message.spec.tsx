import type { JsonObject, Message, TemplateSnapshot } from "@whaloc/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import {
	jsonResponse,
	makeAppState,
	makeMessage,
	makeTemplate,
	SECOND_WABA_ID,
	stubFetch,
} from "../../test/factories.ts";
import { MessageBody } from "./message-body.tsx";

/**
 * A template message rendered from the definition the server froze on it (SPEC §2.5): the
 * send's parameters in place, only what it left out marked, and the send JSON one click away.
 */
const ORDER_SNAPSHOT: TemplateSnapshot = {
	parameterFormat: "POSITIONAL",
	components: [
		{ type: "HEADER", format: "TEXT", text: "Order {{1}}" },
		{ type: "BODY", text: "Hi, order {{1}} ships on {{2}}." },
		{ type: "FOOTER", text: "Reply STOP to opt out" },
		{
			type: "BUTTONS",
			buttons: [
				{ type: "QUICK_REPLY", text: "Talk to us" },
				{ type: "URL", text: "Track", url: "https://shop.test/track/{{1}}" },
				{ type: "PHONE_NUMBER", text: "Call", phone_number: "+15550001234" },
			],
		},
	],
};

function templateMessage(template: JsonObject, snapshot: TemplateSnapshot | null = ORDER_SNAPSHOT): Message {
	return makeMessage({
		type: "template",
		payload: { template: { name: "order_update", language: { code: "en_US" }, ...template } },
		...(snapshot !== null && { templateSnapshot: snapshot }),
	});
}

function renderBody(message: Message, state: Partial<AppState> = {}): void {
	render(
		<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
			<MessageBody message={message} />
		</StoreProvider>,
	);
}

describe("a template message", () => {
	it("fills positional placeholders from each component's own parameters", () => {
		renderBody(
			templateMessage({
				components: [
					{ type: "header", parameters: [{ type: "text", text: "A-17" }] },
					{
						type: "body",
						parameters: [
							{ type: "text", text: "B-42" },
							{ type: "text", text: "Friday" },
						],
					},
					{ type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "B-42" }] },
				],
			}),
		);

		expect(screen.getByText("Order A-17")).toBeTruthy();
		expect(screen.getByText("Hi, order B-42 ships on Friday.")).toBeTruthy();
		expect(screen.getByText("Reply STOP to opt out")).toBeTruthy();
		expect(document.querySelector("mark.placeholder")).toBeNull();
	});

	it("fills named placeholders by parameter_name, whatever order they arrive in", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{
							type: "body",
							parameters: [
								{ type: "text", parameter_name: "day", text: "Monday" },
								{ type: "text", parameter_name: "first_name", text: "Ana" },
							],
						},
					],
				},
				{ parameterFormat: "NAMED", components: [{ type: "BODY", text: "Hi {{first_name}}, see you {{day}}" }] },
			),
		);

		expect(screen.getByText("Hi Ana, see you Monday")).toBeTruthy();
	});

	it("uses the fallback value of a currency parameter", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{
							type: "body",
							parameters: [
								{ type: "currency", currency: { fallback_value: "$10.99", code: "USD", amount_1000: 10_990 } },
							],
						},
					],
				},
				{ parameterFormat: "POSITIONAL", components: [{ type: "BODY", text: "You owe {{1}}" }] },
			),
		);

		expect(screen.getByText("You owe $10.99")).toBeTruthy();
	});

	it("keeps a placeholder the send did not fill marked", () => {
		renderBody(templateMessage({ components: [{ type: "body", parameters: [{ type: "text", text: "B-42" }] }] }));

		const marks = [...document.querySelectorAll("mark.placeholder")].map(mark => mark.textContent);

		// The header's {{1}}, the body's {{2}} and the URL button's {{1}}: the body's {{1}} was filled.
		expect(marks).toEqual(["{{1}}", "{{2}}", "{{1}}"]);
		expect(screen.getByText(/Hi, order B-42 ships on/)).toBeTruthy();
	});

	it("renders the buttons as rows, with a URL button's suffix filled from its button component", () => {
		renderBody(
			templateMessage({
				components: [{ type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "B-42" }] }],
			}),
		);

		expect(screen.getByText("Talk to us")).toBeTruthy();
		expect(screen.getByRole("link", { name: /Track/ }).getAttribute("href")).toBe("https://shop.test/track/B-42");
		expect(screen.getByRole("link", { name: /Call/ }).getAttribute("href")).toBe("tel:+15550001234");
	});

	it("shows the media the send attached to a media header, not the review sample", async () => {
		const fetchMock = stubFetch(() => {
			return Promise.resolve(
				jsonResponse({
					data: {
						id: "4490709327384033",
						url: "http://whaloc:8080/whaloc-media/token",
						mimeType: "image/png",
						sha256: "abc",
						fileSize: 12,
					},
				}),
			);
		});

		renderBody(
			templateMessage(
				{ components: [{ type: "header", parameters: [{ type: "image", image: { id: "4490709327384033" } }] }] },
				{
					parameterFormat: "POSITIONAL",
					components: [
						{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1hZ2U=:ARb"] } },
						{ type: "BODY", text: "Your photo" },
					],
				},
			),
		);

		const image = await screen.findByRole("img");

		expect(image.getAttribute("src")).toBe("/whaloc-media/token");
		expect(fetchMock.mock.calls.map(call => call[0])).toEqual([expect.stringContaining("/api/media/4490709327384033")]);
	});

	it("links a media header sent by link", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{
							type: "header",
							parameters: [
								{ type: "document", document: { link: "https://cdn.test/invoice.pdf", filename: "invoice.pdf" } },
							],
						},
					],
				},
				{ parameterFormat: "POSITIONAL", components: [{ type: "HEADER", format: "DOCUMENT" }] },
			),
		);

		expect(screen.getByRole("link", { name: "invoice.pdf" }).getAttribute("href")).toBe("https://cdn.test/invoice.pdf");
	});

	it("renders an image header sent by link as the image, not as a link", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{ type: "header", parameters: [{ type: "image", image: { link: "https://cdn.test/banner.jpg" } }] },
					],
				},
				{ parameterFormat: "POSITIONAL", components: [{ type: "HEADER", format: "IMAGE" }] },
			),
		);

		expect(screen.getByRole("img").getAttribute("src")).toBe("https://cdn.test/banner.jpg");
		expect(screen.queryByRole("link", { name: "https://cdn.test/banner.jpg" })).toBeNull();
	});

	it("still fills a URL button from a component that names no sub_type", () => {
		renderBody(
			templateMessage({ components: [{ type: "button", index: 1, parameters: [{ type: "text", text: "B-42" }] }] }),
		);

		expect(screen.getByRole("link", { name: /Track/ }).getAttribute("href")).toBe("https://shop.test/track/B-42");
	});

	it("fills a URL button only from a url component, not another sub_type at its index", () => {
		renderBody(
			templateMessage({
				components: [
					{ type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "text", text: "B-42" }] },
				],
			}),
		);

		expect(screen.queryByRole("link", { name: /Track/ })).toBeNull();
	});

	it("shows an OTP button's code, which authentication templates send as sub_type url", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{ type: "body", parameters: [{ type: "text", text: "482913" }] },
						{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
					],
				},
				{
					parameterFormat: "POSITIONAL",
					components: [
						{ type: "BODY", text: "{{1}} is your verification code." },
						{ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
					],
				},
			),
		);

		expect(screen.getByText("482913", { selector: ".template__button-detail" })).toBeTruthy();
	});

	it("shows a COPY_CODE button's coupon_code from its copy_code component", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{
							type: "button",
							sub_type: "copy_code",
							index: 0,
							parameters: [{ type: "coupon_code", coupon_code: "VOLTA10" }],
						},
					],
				},
				{
					parameterFormat: "POSITIONAL",
					components: [
						{ type: "BODY", text: "Here is your discount" },
						{ type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "SAMPLE" }] },
					],
				},
			),
		);

		expect(screen.getByText("VOLTA10", { selector: ".template__button-detail" })).toBeTruthy();
	});

	it("renders a video header sent by link as the video", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{ type: "header", parameters: [{ type: "video", video: { link: "https://cdn.test/tour.mp4" } }] },
					],
				},
				{ parameterFormat: "POSITIONAL", components: [{ type: "HEADER", format: "VIDEO" }] },
			),
		);

		expect(document.querySelector("video.media__video")?.getAttribute("src")).toBe("https://cdn.test/tour.mp4");
	});

	it("does not link a URL button whose dynamic part the send left out", () => {
		renderBody(templateMessage({ components: [] }));

		expect(screen.queryByRole("link", { name: /Track/ })).toBeNull();
		expect(screen.getByText("Track")).toBeTruthy();
		expect(screen.getByText("{{1}}", { selector: ".template__button-detail mark" })).toBeTruthy();
	});

	it("never shows the review sample as a header the send did not attach", () => {
		const fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ error: { message: "unexpected" } }, 500)));

		renderBody(
			templateMessage(
				{ components: [] },
				{
					parameterFormat: "POSITIONAL",
					components: [
						{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1hZ2U=:ARb"] } },
						{ type: "BODY", text: "Your photo" },
					],
				},
			),
		);

		expect(screen.getByText("no image sent")).toBeTruthy();
		expect(screen.queryByRole("img")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("renders a location header from the send's location parameter", () => {
		renderBody(
			templateMessage(
				{
					components: [
						{
							type: "header",
							parameters: [
								{
									type: "location",
									location: { latitude: 41.409, longitude: -75.6624, name: "Dunder Mifflin", address: "Scranton, PA" },
								},
							],
						},
					],
				},
				{
					parameterFormat: "POSITIONAL",
					components: [
						{ type: "HEADER", format: "LOCATION" },
						{ type: "BODY", text: "Meet us here" },
					],
				},
			),
		);

		expect(screen.getByText("Dunder Mifflin")).toBeTruthy();
		expect(screen.getByText("Scranton, PA")).toBeTruthy();
		expect(screen.getByText("41.40900, -75.66240")).toBeTruthy();
	});

	it("keeps the send JSON one click away", () => {
		renderBody(templateMessage({ components: [{ type: "body", parameters: [{ type: "text", text: "B-42" }] }] }));

		expect(screen.getByText("template · order_update · en_US")).toBeTruthy();
		expect(document.querySelector(".json")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "raw" }));

		expect(document.querySelector(".json")?.textContent).toContain('"text": "B-42"');
		expect(screen.getByRole("button", { name: "hide raw" }).getAttribute("aria-expanded")).toBe("true");
	});

	describe("stored before whaloc kept the definition", () => {
		it("borrows the template the store holds for that WABA, name and language, and says so", () => {
			renderBody(
				templateMessage({ components: [{ type: "body", parameters: [{ type: "text", text: "B-42" }] }] }, null),
				{
					templates: [makeTemplate({ status: "APPROVED" })],
				},
			);

			expect(screen.getByText("Your order B-42 shipped")).toBeTruthy();
			expect(screen.getByText(/current definition/)).toBeTruthy();
		});

		it.each([
			["another WABA", { wabaId: SECOND_WABA_ID }],
			["another language", { language: "pt_BR" }],
		])("does not borrow a template from %s", (_label, overrides) => {
			renderBody(
				templateMessage({ components: [{ type: "body", parameters: [{ type: "text", text: "B-42" }] }] }, null),
				{ templates: [makeTemplate({ status: "APPROVED", ...overrides })] },
			);

			expect(screen.queryByText("Your order B-42 shipped")).toBeNull();
			expect(screen.getByText("template")).toBeTruthy();
		});

		it("falls back to the name and the send's components when there is nothing to render from", () => {
			renderBody(
				templateMessage({ components: [{ type: "body", parameters: [{ type: "text", text: "B-42" }] }] }, null),
			);

			expect(screen.getByText("template").classList.contains("chip")).toBe(true);
			expect(screen.getByText("order_update")).toBeTruthy();
			expect(document.querySelector(".json")?.textContent).toContain('"text": "B-42"');
		});
	});
});
