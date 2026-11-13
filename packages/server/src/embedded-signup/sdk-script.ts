import { LOGIN_RESPONSE_TYPE } from "@whaloc/shared";

/** The dialog the SDK opens, relative to wherever `sdk.js` was loaded from. */
export const DIALOG_PATH = "dialog/embedded-signup";

/**
 * How long the SDK waits, once the dialog is gone, for a code that was posted just before it
 * closed. `postMessage` and `window.close()` race across processes.
 */
const CLOSE_GRACE_MS = 500;
const CLOSED_POLL_MS = 250;

/**
 * The stand-in for Meta's JavaScript SDK (SPEC §2.24), as the browser runs it: `FB.init` and
 * `FB.login`, and nothing else the Embedded Signup flow does not touch.
 *
 * Plain ES2017 in one IIFE so it runs untranspiled wherever the real SDK would. The dialog's
 * origin is derived from `document.currentScript`, so whaloc needs no configuration to point at
 * itself, and the `code` is only accepted from that origin and that window.
 */
export const SDK_SCRIPT = `(function () {
	"use strict";
	var script = document.currentScript;
	var dialogUrl = new URL(${JSON.stringify(DIALOG_PATH)}, script && script.src ? script.src : location.href);
	var appId = null;
	var version = null;
	// Every login reuses the one named popup, so a second login ends the first: otherwise both
	// listeners would answer to the same dialog and both callbacks would get its single-use code.
	var endPrevious = null;

	function login(callback, options) {
		if (appId === null) {
			console.error("FB.login() called before FB.init().");
			return;
		}

		if (endPrevious !== null) endPrevious();

		var settings = options || {};
		var url = new URL(dialogUrl.href);
		url.searchParams.set("app_id", appId);
		url.searchParams.set("origin", location.origin);
		if (version !== null) url.searchParams.set("version", version);
		if (settings.config_id !== undefined) url.searchParams.set("config_id", String(settings.config_id));
		if (settings.extras !== undefined) url.searchParams.set("extras", JSON.stringify(settings.extras));

		var popup = window.open(url.href, "whaloc_embedded_signup", "width=640,height=760");
		var done = false;
		var poll = null;

		function finish(response) {
			if (done) return;
			done = true;
			if (endPrevious === cancel) endPrevious = null;
			window.removeEventListener("message", onMessage);
			if (poll !== null) clearInterval(poll);
			if (typeof callback === "function") callback(response);
		}

		function onMessage(event) {
			if (event.origin !== dialogUrl.origin || event.source !== popup) return;
			var data;
			try {
				data = JSON.parse(event.data);
			} catch (error) {
				return;
			}
			if (data && data.type === ${JSON.stringify(LOGIN_RESPONSE_TYPE)} && typeof data.code === "string") {
				finish({ authResponse: { code: data.code }, status: "connected" });
			}
		}

		function cancel() {
			finish({ authResponse: null, status: "unknown" });
		}

		if (!popup) {
			cancel();
			return;
		}

		endPrevious = cancel;
		window.addEventListener("message", onMessage);
		poll = setInterval(function () {
			if (popup.closed) {
				clearInterval(poll);
				poll = null;
				setTimeout(function () {
					finish({ authResponse: null, status: "unknown" });
				}, ${String(CLOSE_GRACE_MS)});
			}
		}, ${String(CLOSED_POLL_MS)});
	}

	window.FB = {
		init: function (params) {
			appId = params && params.appId !== undefined ? String(params.appId) : null;
			version = params && params.version !== undefined ? String(params.version) : null;
		},
		login: login,
	};

	if (typeof window.fbAsyncInit === "function") window.fbAsyncInit();
})();
`;
