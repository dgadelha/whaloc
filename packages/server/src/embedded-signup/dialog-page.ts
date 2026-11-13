import type { SignupChoice, SignupResult } from "../domain/index.ts";
import { LOGIN_RESPONSE_TYPE } from "./sdk-script.ts";

/**
 * The Embedded Signup dialog's HTML (SPEC §2.24): server-rendered, no bundle, because it is a
 * popup the page under test opens on whaloc's origin and must work without the web UI built.
 */

/** Meta's `current_step` values for a `CANCEL` (Embedded Signup errors reference). */
export const CANCEL_STEPS = [
	"ASSET_SELECTION",
	"ASSET_CREATION",
	"PHONE_NUMBER_SETUP",
	"PHONE_NUMBER_VERIFICATION",
	"WHATSAPP_BUSINESS_APP_ONBOARDING_PHONE_CREATION",
	"WHATSAPP_BUSINESS_APP_ONBOARDING_QR_CODE",
] as const;

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
	return value.replaceAll(/["&'<>]/g, character => HTML_ESCAPES[character] ?? character);
}

/** JSON that is safe inside a `<script>` element: nothing in it can close the element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", String.raw`\u003c`);
}

const STYLE = `
body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; max-width: 560px; color: #1c1e21; }
h1 { font-size: 18px; } fieldset { border: 1px solid #ccd0d5; border-radius: 6px; margin: 0 0 12px; padding: 8px 12px; }
label { display: block; margin: 6px 0; } input[type=text], select { width: 100%; box-sizing: border-box; padding: 4px; }
.error { color: #b00020; } .actions { display: flex; gap: 8px; flex-wrap: wrap; }
`;

function htmlDocument(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Posts strings, like Meta does, to the page that opened the dialog, then closes it. */
const POST_SCRIPT = `
function postToOpener(messages, origin) {
	if (window.opener) {
		for (const message of messages) window.opener.postMessage(JSON.stringify(message), origin);
	}
	window.close();
}`;

/** The dialog refusing to start: an unknown app, or no origin to answer to. */
export function refusalPage(message: string): string {
	return htmlDocument("Embedded Signup", `<h1>Embedded Signup</h1>\n<p class="error">${escapeHtml(message)}</p>`);
}

export interface DialogPageInput {
	appId: string;
	origin: string;
	choices: SignupChoice[];
	errorSession: { sessionId: string; timestamp: string };
	/** Why the last submission was refused, shown above the form. */
	error?: string;
}

function wabaOptions(choices: readonly SignupChoice[]): string {
	return [
		...choices.map(
			({ waba }) => `<option value="${escapeHtml(waba.id)}">${escapeHtml(waba.name)} (${escapeHtml(waba.id)})</option>`,
		),
		`<option value="new">Create a new WABA</option>`,
	].join("");
}

function phoneNumberOptions(choices: readonly SignupChoice[]): string {
	return [
		`<option value="none">Continue without a phone number</option>`,
		`<option value="new">Add a new phone number</option>`,
		...choices.flatMap(({ waba, phoneNumbers }) => {
			return phoneNumbers.map(phoneNumber => {
				const label = `${phoneNumber.displayPhoneNumber} on ${waba.name}`;

				return `<option value="${escapeHtml(phoneNumber.id)}">${escapeHtml(label)}</option>`;
			});
		}),
	].join("");
}

/** The form: the WABA, the number, and the two ways out that produce no code. */
export function dialogPage(input: DialogPageInput): string {
	const error = input.error === undefined ? "" : `<p class="error">${escapeHtml(input.error)}</p>`;
	const steps = CANCEL_STEPS.map(step => `<option>${step}</option>`).join("");

	return htmlDocument(
		"Embedded Signup",
		`<h1>Connect a WhatsApp Business account</h1>
${error}
<form method="post">
<input type="hidden" name="app_id" value="${escapeHtml(input.appId)}">
<input type="hidden" name="origin" value="${escapeHtml(input.origin)}">
<fieldset><legend>WhatsApp Business account</legend>
<label>Account <select name="waba">${wabaOptions(input.choices)}</select></label>
<label>Name of a new account <input type="text" name="waba_name" value="New WABA"></label>
</fieldset>
<fieldset><legend>Phone number</legend>
<label>Number <select name="phone_number_choice">${phoneNumberOptions(input.choices)}</select></label>
<label>New number, with country code <input type="text" name="phone_number" placeholder="+1 631 555 0100"></label>
<label>Display name <input type="text" name="verified_name" value="whaloc business"></label>
<label><input type="checkbox" name="coexistence"> Already on the WhatsApp Business app (coexistence)</label>
</fieldset>
<div class="actions"><button type="submit">Finish</button></div>
</form>
<fieldset><legend>Leave without finishing</legend>
<label>Cancel at step <select id="current_step">${steps}</select></label>
<label>Error code <input type="text" id="error_code" value="1"></label>
<label>Error message <input type="text" id="error_message" value="An unexpected error occurred"></label>
<div class="actions"><button type="button" id="cancel">Cancel</button><button type="button" id="error">Simulate error</button></div>
</fieldset>
<script>
${POST_SCRIPT}
const session = ${scriptJson({ origin: input.origin, ...input.errorSession })};
const valueOf = id => document.getElementById(id).value;
document.getElementById("cancel").addEventListener("click", () => {
	postToOpener([{ data: { current_step: valueOf("current_step") }, type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" }], session.origin);
});
document.getElementById("error").addEventListener("click", () => {
	postToOpener([{
		data: { error_message: valueOf("error_message"), error_code: valueOf("error_code"), session_id: session.sessionId, timestamp: session.timestamp },
		type: "WA_EMBEDDED_SIGNUP",
		event: "ERROR",
	}], session.origin);
});
</script>`,
	);
}

/** The id of the JSON block that holds what the finished dialog posts. */
export const RESULT_ELEMENT_ID = "whaloc-signup-result";

/**
 * The finished dialog: posts Meta's session event, then the code (whaloc's own message, which
 * the SDK turns into `authResponse.code`), then closes. Both go to the opener's origin only.
 */
export function resultPage(origin: string, result: SignupResult): string {
	const payload = {
		origin,
		messages: [result.sessionEvent, { type: LOGIN_RESPONSE_TYPE, code: result.code }],
	};

	return htmlDocument(
		"Embedded Signup",
		`<h1>Account connected</h1>
<p>You can close this window.</p>
<script type="application/json" id="${RESULT_ELEMENT_ID}">${scriptJson(payload)}</script>
<script>
${POST_SCRIPT}
const result = JSON.parse(document.getElementById("${RESULT_ELEMENT_ID}").textContent);
postToOpener(result.messages, result.origin);
</script>`,
	);
}
