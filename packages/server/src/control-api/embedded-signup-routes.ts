import {
	signupAppQuerySchema,
	signupChoicesResponseSchema,
	signupCompleteRequestSchema,
	signupCompleteResponseSchema,
	signupErrorSessionResponseSchema,
} from "@whaloc/shared";
import { Hono } from "hono";
import { toPhoneNumberDto, toWabaDto, type EmbeddedSignupService } from "../domain/index.ts";
import { parseOrThrow, readBody, type ControlEnv } from "./control-env.ts";

export interface EmbeddedSignupRoutesOptions {
	embeddedSignup: EmbeddedSignupService;
}

/**
 * What the Embedded Signup dialog asks whaloc (SPEC §2.24). The dialog is a page of the web UI,
 * so it talks to the control plane like every other page; only what it posts to its opener is
 * Meta's.
 */
export function createEmbeddedSignupRoutes(options: EmbeddedSignupRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const signup = options.embeddedSignup;

	routes.get("/embedded-signup/choices", async c => {
		const { app_id: appId } = parseOrThrow(signupAppQuerySchema, c.req.query());
		const choices = await signup.choices(appId);

		return c.json(
			signupChoicesResponseSchema.parse({
				data: choices.map(({ waba, phoneNumbers }) => {
					return {
						waba: toWabaDto(waba),
						phoneNumbers: phoneNumbers.map(phoneNumber => toPhoneNumberDto(phoneNumber)),
					};
				}),
			}),
		);
	});

	routes.post("/embedded-signup/complete", async c => {
		const body = await readBody(c, signupCompleteRequestSchema);

		return c.json(signupCompleteResponseSchema.parse({ data: await signup.complete(body) }));
	});

	routes.get("/embedded-signup/error-session", c => {
		const { app_id: appId } = parseOrThrow(signupAppQuerySchema, c.req.query());

		return c.json(signupErrorSessionResponseSchema.parse({ data: signup.errorSession(appId) }));
	});

	return routes;
}
