import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.ts";
import { isControlPlaneError, type EmbeddedSignupService, type SignupRequest } from "../domain/index.ts";
import { dialogPage, refusalPage, resultPage } from "./dialog-page.ts";
import { DIALOG_PATH, SDK_SCRIPT } from "./sdk-script.ts";

export interface EmbeddedSignupRoutesOptions {
	embeddedSignup: EmbeddedSignupService;
}

/** Short enough that a new whaloc version reaches the browser within a minute. */
const SDK_CACHE_CONTROL = "public, max-age=60";

/** The page that opened the dialog: an http(s) origin, nothing more. */
function originOf(value: string | undefined): string | null {
	if (value === undefined || !URL.canParse(value)) {
		return null;
	}

	const url = new URL(value);

	return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? url.origin : null;
}

const signupFormSchema = z.object({
	app_id: z.string(),
	origin: z.string(),
	waba: z.string().min(1),
	waba_name: z.string().trim().default(""),
	phone_number_choice: z.string().min(1),
	phone_number: z.string().trim().default(""),
	verified_name: z.string().trim().default(""),
	coexistence: z.literal("on").optional(),
});

type SignupForm = z.infer<typeof signupFormSchema>;

function phoneNumberOf(form: SignupForm): SignupRequest["phoneNumber"] {
	switch (form.phone_number_choice) {
		case "none": {
			return { kind: "none" };
		}
		case "new": {
			return {
				kind: "new",
				phoneNumber: form.phone_number,
				verifiedName: form.verified_name,
				coexistence: form.coexistence !== undefined,
			};
		}
		default: {
			return { kind: "existing", id: form.phone_number_choice };
		}
	}
}

/** The form's flat fields as the domain's request, or what is missing from them. */
function toSignupRequest(form: SignupForm): SignupRequest | string {
	if (form.waba === "new" && form.waba_name === "") {
		return "A new WABA needs a name.";
	}

	if (form.phone_number_choice === "new" && (form.phone_number === "" || form.verified_name === "")) {
		return "A new phone number needs the number and a display name.";
	}

	return {
		appId: form.app_id,
		waba: form.waba === "new" ? { kind: "new", name: form.waba_name } : { kind: "existing", id: form.waba },
		phoneNumber: phoneNumberOf(form),
	};
}

/**
 * The browser half of Embedded Signup (SPEC §2.24): Meta's JavaScript SDK stand-in at `/sdk.js`
 * and the dialog `FB.login` opens. Neither is under a Graph version prefix, because neither is a
 * Graph call: they are what `connect.facebook.net` and `www.facebook.com` serve.
 *
 * `config_id`, `extras` and `version` reach the dialog and are ignored: the choices they make
 * at Meta are made in the dialog's form instead.
 */
export function createEmbeddedSignupRoutes(options: EmbeddedSignupRoutesOptions): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();
	const signup = options.embeddedSignup;

	async function form(c: Context<AppEnv>, appId: string, origin: string, error?: string): Promise<Response> {
		const page = dialogPage({
			appId,
			origin,
			choices: await signup.choices(),
			errorSession: signup.errorSession(),
			...(error !== undefined && { error }),
		});

		return c.html(page, error === undefined ? 200 : 400);
	}

	routes.get("/sdk.js", c => {
		c.header("Content-Type", "application/javascript; charset=utf-8");
		c.header("Cache-Control", SDK_CACHE_CONTROL);

		return c.body(SDK_SCRIPT);
	});

	routes.get(`/${DIALOG_PATH}`, async c => {
		const appId = c.req.query("app_id");
		const origin = originOf(c.req.query("origin"));

		if (appId === undefined || !signup.isKnownApp(appId)) {
			return c.html(refusalPage(`App ID ${appId ?? "(none)"} is not this whaloc's app.`), 400);
		}

		if (origin === null) {
			return c.html(refusalPage("The dialog has no page to answer to: open it through FB.login."), 400);
		}

		return form(c, appId, origin);
	});

	routes.post(`/${DIALOG_PATH}`, async c => {
		const parsed = signupFormSchema.safeParse(await c.req.parseBody());
		const origin = parsed.success ? originOf(parsed.data.origin) : null;

		if (origin === null || !parsed.success || !signup.isKnownApp(parsed.data.app_id)) {
			return c.html(refusalPage("This form was not opened through FB.login."), 400);
		}

		const request = toSignupRequest(parsed.data);

		if (typeof request === "string") {
			return form(c, parsed.data.app_id, origin, request);
		}

		try {
			return c.html(resultPage(origin, await signup.complete(request)));
		} catch (error) {
			if (isControlPlaneError(error)) {
				return form(c, parsed.data.app_id, origin, error.message);
			}

			throw error;
		}
	});

	return routes;
}
