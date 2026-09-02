import { describe, expect, it } from "vitest";
import { parseFields, projectFields } from "./fields.ts";

const NODE = { name: "Acme", status: "APPROVED", category: "UTILITY", id: "123" };

describe("parseFields", () => {
	it("reports no projection when the query parameter is absent", () => {
		expect(parseFields(undefined)).toBeNull();
	});

	it("splits a comma-separated list", () => {
		expect(parseFields("id,name,status")).toEqual(["id", "name", "status"]);
	});

	it("trims the entries", () => {
		expect(parseFields(" id , name ")).toEqual(["id", "name"]);
	});

	it("flattens a nested selector", () => {
		expect(parseFields("throughput{level},id")).toEqual(["throughput", "id"]);
	});

	it.each(["", ",", "  ,  "])("treats %o as no projection", raw => {
		expect(parseFields(raw)).toBeNull();
	});
});

describe("projectFields", () => {
	it("returns every field when nothing was requested", () => {
		expect(projectFields(NODE, null)).toEqual(NODE);
	});

	it("returns only the requested fields", () => {
		expect(projectFields(NODE, ["name", "status"])).toEqual({ name: "Acme", status: "APPROVED", id: "123" });
	});

	it("always includes id, the way Meta does on a node read", () => {
		expect(projectFields(NODE, ["name"])).toHaveProperty("id", "123");
		expect(projectFields(NODE, ["id"])).toEqual({ id: "123" });
	});

	it("ignores fields the node does not have", () => {
		expect(projectFields(NODE, ["name", "not_a_field"])).toEqual({ name: "Acme", id: "123" });
	});

	it("does not invent an id for a node without one", () => {
		expect(projectFields({ level: "STANDARD" }, ["level"])).toEqual({ level: "STANDARD" });
	});

	it("copies rather than aliases the node", () => {
		const projected = projectFields(NODE, null);

		projected["name"] = "changed";

		expect(NODE.name).toBe("Acme");
	});
});
