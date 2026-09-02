import { describe, expect, it } from "vitest";
import { extractPlaceholders, templatePlaceholders } from "./template-placeholders.ts";

describe("extractPlaceholders", () => {
	it("finds positional placeholders in order", () => {
		expect(extractPlaceholders("Shop through {{1}} with code {{2}} for {{3}} off")).toEqual(["1", "2", "3"]);
	});

	it("finds named placeholders in order", () => {
		expect(extractPlaceholders("Hi {{customer_name}}, order {{order_id}} shipped")).toEqual([
			"customer_name",
			"order_id",
		]);
	});

	it("counts a repeated placeholder once", () => {
		expect(extractPlaceholders("{{name}} — see you {{day}}, {{name}}")).toEqual(["name", "day"]);
	});

	it("tolerates whitespace inside the braces", () => {
		expect(extractPlaceholders("Hi {{ name }}")).toEqual(["name"]);
	});

	it("finds nothing in text without placeholders", () => {
		expect(extractPlaceholders("Reply STOP to unsubscribe")).toEqual([]);
		expect(extractPlaceholders("{ not a placeholder }")).toEqual([]);
		expect(extractPlaceholders("{{}}")).toEqual([]);
	});
});

describe("templatePlaceholders", () => {
	it("reads the header and body of a stored template", () => {
		const placeholders = templatePlaceholders([
			{ type: "HEADER", format: "TEXT", text: "Our {{1}} is on!" },
			{ type: "BODY", text: "Use {{2}} before {{3}}" },
			{ type: "FOOTER", text: "Reply STOP — {{99}} is ignored here" },
		]);

		expect(placeholders).toEqual({ header: ["1"], body: ["2", "3"] });
	});

	it("reports an empty list for a component that declares no placeholder", () => {
		expect(templatePlaceholders([{ type: "BODY", text: "Your order shipped" }])).toEqual({ header: [], body: [] });
	});

	it("ignores a media header, which takes a media parameter instead of text", () => {
		const placeholders = templatePlaceholders([
			{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1h"] } },
			{ type: "BODY", text: "Hi {{1}}" },
		]);

		expect(placeholders).toEqual({ header: [], body: ["1"] });
	});

	it("accepts the lower-case component types a send uses", () => {
		expect(templatePlaceholders([{ type: "body", text: "Hi {{name}}" }])).toEqual({ header: [], body: ["name"] });
	});

	it("survives components that are not shaped like components", () => {
		expect(templatePlaceholders([{ type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }, {}])).toEqual({
			header: [],
			body: [],
		});
	});
});
