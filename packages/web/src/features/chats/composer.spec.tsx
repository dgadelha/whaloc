import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import {
	CONTACT_WA_ID,
	jsonResponse,
	makeAppState,
	makeMessage,
	PHONE_NUMBER_ID,
	requestBodyOf,
	stubFetch,
	type FetchMock,
} from "../../test/factories.ts";
import { Composer } from "./composer.tsx";

/**
 * The composer through the DOM: what a click and a keystroke actually put on the wire. The
 * payload shapes themselves are covered by `composer-payload.spec.ts`; this is about the form
 * reaching them — Enter sending, the media upload happening first, an invalid draft never
 * being sent at all.
 */
function renderComposer(props: Partial<Parameters<typeof Composer>[0]> = {}): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(
		<Composer
			phoneNumberId={PHONE_NUMBER_ID}
			contactWaId={CONTACT_WA_ID}
			replyTo={null}
			onClearReply={() => {}}
			reactionTarget={null}
			onClearReaction={() => {}}
			{...props}
		/>,
		{ wrapper },
	);
}

describe("Composer", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makeMessage({ direction: "inbound" }) }, 201)));
	});

	it("sends the text on Enter", async () => {
		renderComposer();

		fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hello there" } });
		fireEvent.keyDown(screen.getByLabelText("Message text"), { key: "Enter" });

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe("/api/inbound");
		expect(init?.method).toBe("POST");
		expect(requestBodyOf(fetchMock)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: CONTACT_WA_ID,
			type: "text",
			text: { body: "hello there" },
		});
	});

	it("adds a line instead of sending on Shift+Enter", () => {
		renderComposer();

		fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "line one" } });
		fireEvent.keyDown(screen.getByLabelText("Message text"), { key: "Enter", shiftKey: true });

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("quotes the message being replied to", async () => {
		renderComposer({ replyTo: makeMessage({ id: "wamid.quoted" }) });

		fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "sure" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});
		expect(requestBodyOf(fetchMock)).toMatchObject({ replyTo: "wamid.quoted" });
	});

	it("uploads a file first, then sends the media message that references it", async () => {
		const upload = {
			data: {
				id: "998877",
				phoneNumberId: PHONE_NUMBER_ID,
				mimeType: "image/png",
				sha256: "abc",
				fileSize: 4,
				createdAt: "2026-08-31T12:00:00.000Z",
			},
		};

		fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(upload, 201)));
		renderComposer();

		fireEvent.click(screen.getByRole("tab", { name: "Media" }));
		fireEvent.change(screen.getByLabelText("Attach a file"), {
			target: { files: [new File(["1234"], "photo.png", { type: "image/png" })] },
		});

		await waitFor(() => {
			expect(screen.getByText("media 998877")).toBeTruthy();
		});

		const [uploadPath, uploadInit] = fetchMock.mock.calls[0] ?? [];

		expect(uploadPath).toBe("/api/inbound-media");
		expect(uploadInit?.body).toBeInstanceOf(FormData);

		fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Look" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		expect(requestBodyOf(fetchMock, 1)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: CONTACT_WA_ID,
			type: "image",
			media: { id: "998877", caption: "Look", filename: "photo.png" },
		});
	});

	it("sends a location as numbers", async () => {
		renderComposer();

		fireEvent.click(screen.getByRole("tab", { name: "Location" }));
		fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "-12.9777" } });
		fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-38.5016" } });
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Elevador Lacerda" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});
		expect(requestBodyOf(fetchMock)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: CONTACT_WA_ID,
			type: "location",
			location: { latitude: -12.9777, longitude: -38.5016, name: "Elevador Lacerda" },
		});
	});

	it("sends an interactive list_reply", async () => {
		renderComposer();

		fireEvent.click(screen.getByRole("tab", { name: "Interactive" }));
		fireEvent.change(screen.getByLabelText("Reply kind"), { target: { value: "list_reply" } });
		fireEvent.change(screen.getByLabelText("Id"), { target: { value: "row-1" } });
		fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Small" } });
		fireEvent.change(screen.getByLabelText("Description"), { target: { value: "12cm" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});
		expect(requestBodyOf(fetchMock)).toMatchObject({
			type: "interactive",
			interactive: { type: "list_reply", list_reply: { id: "row-1", title: "Small", description: "12cm" } },
		});
	});

	it("switches to the reaction form when a message is picked from a bubble", async () => {
		renderComposer({ reactionTarget: makeMessage({ id: "wamid.target" }) });

		const target = screen.getByLabelText<HTMLInputElement>("Message ID");

		expect(target.value).toBe("wamid.target");

		fireEvent.click(screen.getByRole("button", { name: "React ❤️" }));
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});
		expect(requestBodyOf(fetchMock)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: CONTACT_WA_ID,
			type: "reaction",
			reaction: { message_id: "wamid.target", emoji: "❤️" },
		});
	});

	it("shows the validation error instead of sending an invalid draft", () => {
		renderComposer();

		fireEvent.click(screen.getByRole("tab", { name: "Contacts" }));
		fireEvent.change(screen.getByLabelText("Contact cards (JSON)"), { target: { value: "{oops" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.getByText(/contacts must be valid JSON/)).toBeTruthy();
	});

	/**
	 * The **Extras** panel (SPEC §5). What matters is the body it produces, and that the riders
	 * survive a mode switch — they describe how a message arrived, not what is in it.
	 */
	describe("context riders", () => {
		function openExtras(): void {
			fireEvent.click(screen.getByRole("button", { name: /Extras/ }));
		}

		it("is collapsed until it is asked for", () => {
			renderComposer();

			expect(screen.queryByLabelText("context.forwarded")).toBeNull();
			expect(screen.queryByText("context.forwarded")).toBeNull();
		});

		it("adds forwarded and frequentlyForwarded to the body", async () => {
			renderComposer();
			openExtras();

			fireEvent.click(screen.getByText("context.forwarded"));
			fireEvent.click(screen.getByText("context.frequently_forwarded"));
			fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "passing this on" } });
			fireEvent.click(screen.getByRole("button", { name: "Send" }));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});

			expect(requestBodyOf(fetchMock)).toMatchObject({
				type: "text",
				forwarded: true,
				frequentlyForwarded: true,
			});
		});

		it("sends a referral in Meta's snake_case, dropping the fields left blank", async () => {
			renderComposer();
			openExtras();

			fireEvent.click(screen.getByText(/referral —/));
			fireEvent.change(screen.getByLabelText("source_url"), { target: { value: "https://fb.me/2Ax9kLm" } });
			fireEvent.change(screen.getByLabelText("source_id"), { target: { value: "120210000000000000" } });
			fireEvent.change(screen.getByLabelText("headline"), { target: { value: "Autumn sale" } });
			fireEvent.change(screen.getByLabelText("media_type"), { target: { value: "image" } });
			fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "is this available?" } });
			fireEvent.click(screen.getByRole("button", { name: "Send" }));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});

			const body = requestBodyOf(fetchMock) as { referral: Record<string, unknown> };

			expect(body.referral).toEqual({
				source_url: "https://fb.me/2Ax9kLm",
				source_type: "ad",
				source_id: "120210000000000000",
				headline: "Autumn sale",
				media_type: "image",
			});
		});

		it("sends a referred product, and keeps the riders across a mode switch", async () => {
			renderComposer();
			openExtras();

			fireEvent.click(screen.getByText(/context.referred_product/));
			fireEvent.change(screen.getByLabelText("catalog_id"), { target: { value: "1234567" } });
			fireEvent.change(screen.getByLabelText("product_retailer_id"), { target: { value: "SKU-9" } });

			// The panel is about how the message arrived, so switching type must not clear it.
			fireEvent.click(screen.getByRole("tab", { name: "Location" }));
			fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "-12.97" } });
			fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-38.5" } });
			fireEvent.click(screen.getByRole("button", { name: "Send" }));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});

			expect(requestBodyOf(fetchMock)).toMatchObject({
				type: "location",
				referredProduct: { catalog_id: "1234567", product_retailer_id: "SKU-9" },
			});
		});
	});

	it("sends an unsupported message with nothing but its type", async () => {
		renderComposer();

		fireEvent.click(screen.getByRole("tab", { name: "Unsupported (poll, etc.)" }));
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: CONTACT_WA_ID,
			type: "unsupported",
		});
	});

	it("surfaces a control-plane rejection on the form", async () => {
		fetchMock.mockImplementationOnce(() =>
			Promise.resolve(jsonResponse({ error: { message: "no media object with id 404", code: "unknown_media" } }, 404)),
		);
		renderComposer();

		fireEvent.change(screen.getByLabelText("Message text"), { target: { value: "hi" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(screen.getByText("no media object with id 404")).toBeTruthy();
		});
	});
});
