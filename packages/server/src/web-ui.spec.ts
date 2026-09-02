import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./testing/test-app.ts";
import { isReservedPath } from "./web-ui.ts";

const INDEX_HTML = '<!doctype html><title>whaloc</title><div id="root"></div>';
const ASSET_JS = "console.log('whaloc');\n";

describe("the static web UI", () => {
	let fixture: TestApp;
	let webDir: string;

	beforeEach(async () => {
		webDir = await mkdtemp(path.join(tmpdir(), "whaloc-test-web-"));
		await mkdir(path.join(webDir, "assets"));
		await writeFile(path.join(webDir, "index.html"), INDEX_HTML);
		await writeFile(path.join(webDir, "assets", "index-abc123.js"), ASSET_JS);
		fixture = await createTestApp({ WHALOC_WEB_DIR: webDir });
	});

	afterEach(async () => {
		await fixture.close();
		await rm(webDir, { recursive: true, force: true });
	});

	it("serves index.html at the root", async () => {
		const response = await fixture.app.request("/");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toBe(INDEX_HTML);
	});

	it("serves fingerprinted assets as immutable", async () => {
		const response = await fixture.app.request("/assets/index-abc123.js");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(ASSET_JS);
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
	});

	it("never caches the entry document, so a redeploy is picked up", async () => {
		const response = await fixture.app.request("/");

		expect(response.headers.get("cache-control")).toBe("no-cache");
	});

	// The scoped routes the shell uses (SPEC §8) plus the unscoped entry points that redirect
	// into them: every one of these has to survive a reload and a bookmark.
	it.each([
		"/chats",
		"/templates",
		"/w/666635535888644/p/573542517421694/chats",
		"/w/666635535888644/p/573542517421694/chats/5511912345678",
		"/w/666635535888644/chats",
		"/w/666635535888644/templates",
		"/chats/573542517421694:5511912345678",
		"/webhooks",
		"/settings",
	])("falls back to index.html on the in-app route %s", async route => {
		const response = await fixture.app.request(route);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(INDEX_HTML);
	});

	it.each(["/api/nope", "/api/conversations/x/nope", "/v25.0/nope", "/whaloc-media/nope"])(
		"does not shadow %s with the SPA fallback",
		async reserved => {
			const response = await fixture.app.request(reserved);

			expect(response.status).not.toBe(200);
			expect(await response.text()).not.toBe(INDEX_HTML);
		},
	);

	it("keeps serving the API next to the UI", async () => {
		const response = await fixture.app.request("/api/state");

		expect(response.status).toBe(200);
	});

	it("keeps the health check answering at the root alias", async () => {
		const response = await fixture.app.request("/health");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
	});
});

describe("isReservedPath", () => {
	it.each([
		"/api",
		"/api/state",
		"/api/ws",
		"/v25.0",
		"/v25.0/123/messages",
		"/v1.0/x",
		"/whaloc-media/tok",
		"/health",
	])("reserves %s", pathname => {
		expect(isReservedPath(pathname)).toBe(true);
	});

	it.each(["/", "/chats", "/apidocs", "/healthz", "/whaloc-mediax", "/v25", "/assets/index.js"])(
		"leaves %s to the UI",
		pathname => {
			expect(isReservedPath(pathname)).toBe(false);
		},
	);
});
