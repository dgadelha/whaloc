import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../testing/test-app.ts";
import { LOGIN_RESPONSE_TYPE } from "./sdk-script.ts";

/**
 * The SDK stand-in as a browser runs it (SPEC §2.24): the script `/sdk.js` serves is evaluated
 * against a minimal window, the way the page under test loads Meta's.
 */

const WHALOC_ORIGIN = "https://whaloc.example.test";
const PAGE_ORIGIN = "https://app.example.test";

interface LoginResponse {
	authResponse: { code: string } | null;
	status: string;
}

interface FacebookSdk {
	init: (params: { appId: string; version: string }) => void;
	login: (callback: (response: LoginResponse) => void, options: Record<string, unknown>) => void;
}

interface FakeMessage {
	origin: string;
	source: unknown;
	data: string;
}

/** Loads the served script into a fake page and returns what a page can reach. */
async function loadSdk() {
	const fixture = await createTestApp();
	const response = await fixture.app.request("/sdk.js");
	const source = await response.text();

	await fixture.close();

	const popup = { closed: false };
	const listeners: ((event: FakeMessage) => void)[] = [];
	const opened: string[] = [];
	const window: { FB?: FacebookSdk; fbAsyncInit?: () => void } & Record<string, unknown> = {
		open: (url: string) => {
			opened.push(url);

			return popup;
		},
		addEventListener: (_type: string, listener: (event: FakeMessage) => void) => {
			listeners.push(listener);
		},
		removeEventListener: (_type: string, listener: (event: FakeMessage) => void) => {
			listeners.splice(listeners.indexOf(listener), 1);
		},
	};
	let initialized: FacebookSdk | undefined;

	window.fbAsyncInit = () => {
		initialized = window.FB;
	};

	runInNewContext(source, {
		window,
		document: { currentScript: { src: `${WHALOC_ORIGIN}/sdk.js` } },
		location: { href: `${PAGE_ORIGIN}/connect`, origin: PAGE_ORIGIN },
		URL,
		JSON,
		console,
		setInterval,
		clearInterval,
		setTimeout,
	});

	return {
		response,
		sdk: initialized,
		popup,
		opened,
		post: (event: FakeMessage) => {
			for (const listener of listeners) {
				listener(event);
			}
		},
	};
}

describe("the SDK stand-in", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens the dialog on its own origin and answers with the code only that dialog posts", async () => {
		const { response, sdk, popup, opened, post } = await loadSdk();
		const callback = vi.fn<(response: LoginResponse) => void>();

		sdk?.init({ appId: "4242", version: "v25.0" });
		sdk?.login(callback, { config_id: "777", response_type: "code", extras: { version: "v5" } });

		const dialog = new URL(opened[0] ?? "");
		const login = JSON.stringify({ type: LOGIN_RESPONSE_TYPE, code: "AQcode" });

		post({ origin: PAGE_ORIGIN, source: popup, data: login });
		post({ origin: WHALOC_ORIGIN, source: {}, data: login });

		const ignored = callback.mock.calls.length;

		post({ origin: WHALOC_ORIGIN, source: popup, data: login });

		expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("public, max-age=60");
		expect(`${dialog.origin}${dialog.pathname}`).toBe(`${WHALOC_ORIGIN}/dialog/embedded-signup`);
		expect(Object.fromEntries(dialog.searchParams)).toEqual({
			app_id: "4242",
			origin: PAGE_ORIGIN,
			version: "v25.0",
			config_id: "777",
			extras: JSON.stringify({ version: "v5" }),
		});
		expect(ignored).toBe(0);
		expect(callback.mock.calls).toEqual([[{ authResponse: { code: "AQcode" }, status: "connected" }]]);
	});

	it("reports a dialog closed without a code the way Meta's SDK does", async () => {
		vi.useFakeTimers();

		const { sdk, popup } = await loadSdk();
		const callback = vi.fn<(response: LoginResponse) => void>();

		sdk?.init({ appId: "4242", version: "v25.0" });
		sdk?.login(callback, {});
		popup.closed = true;
		await vi.runAllTimersAsync();

		expect(callback.mock.calls).toEqual([[{ authResponse: null, status: "unknown" }]]);
	});
});
