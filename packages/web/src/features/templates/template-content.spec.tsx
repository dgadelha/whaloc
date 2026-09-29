import type { JsonObject } from "@whaloc/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonResponse, stubFetch } from "../../test/factories.ts";
import { TemplateContent } from "./template-content.tsx";

function imageHeader(handle: string): JsonObject[] {
	return [
		{ type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } },
		{ type: "BODY", text: "Sample" },
	];
}

describe("a template's media header", () => {
	it("drops the previous handle's media when the next one resolves to nothing", async () => {
		stubFetch(input => {
			return Promise.resolve(
				input.includes("first")
					? jsonResponse({
							data: {
								handle: "4::first",
								url: "http://whaloc:8080/whaloc-upload/first",
								mimeType: "image/png",
								sha256: "abc",
								fileSize: 12,
								fileName: "first.png",
								createdAt: "2026-01-01T00:00:00.000Z",
							},
						})
					: jsonResponse({ error: { message: "not found" } }, 404),
			);
		});

		const { rerender } = render(<TemplateContent components={imageHeader("4::first")} />);

		const first = await screen.findByRole("img");

		expect(first.getAttribute("src")).toBe("/whaloc-upload/first");

		rerender(<TemplateContent components={imageHeader("4::second")} />);

		expect(await screen.findByText("image header")).toBeTruthy();
		expect(screen.queryByRole("img")).toBeNull();
	});
});
