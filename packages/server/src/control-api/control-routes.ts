import { Hono } from "hono";
import type { DomainServices } from "../composition.ts";
import type { Logger } from "../logging/index.ts";
import { createContactRoutes } from "./contact-routes.ts";
import { createControlErrorHandler, type ControlEnv } from "./control-env.ts";
import { createConversationRoutes } from "./conversation-routes.ts";
import { createHealthRoutes } from "./health-routes.ts";
import { createInboundRoutes } from "./inbound-routes.ts";
import { createInjectionRoutes } from "./injection-routes.ts";
import { createMediaRoutes } from "./media-routes.ts";
import { createMessageRoutes } from "./message-routes.ts";
import { createPhoneNumberRoutes } from "./phone-number-routes.ts";
import { createSnapshotRoutes } from "./snapshot-routes.ts";
import { createStateRoutes } from "./state-routes.ts";
import { createTemplateRoutes } from "./template-routes.ts";
import { createTokenRoutes } from "./token-routes.ts";
import { createTypingRoutes } from "./typing-routes.ts";
import { createWabaRoutes } from "./waba-routes.ts";
import { createWebhookRoutes } from "./webhook-routes.ts";
import { createWsRoutes } from "./ws-routes.ts";

export interface ControlRoutesOptions {
	services: DomainServices;
	logger: Logger;
}

/**
 * The whole control plane, as one router mounted at `/api` (SPEC §5).
 *
 * There is no authentication: whaloc is a local dev tool whose UI runs in a browser with no
 * credential to give it, and the Graph surface next door already accepts any bearer token.
 * Do not expose the port to a network you do not trust.
 *
 * The error handler is registered here so the plain `{error:{message,code?}}` shape stays a
 * property of *this* surface, while the Graph routes keep answering with Meta's envelope
 * (SPEC §8).
 */
export function createControlRoutes(options: ControlRoutesOptions): Hono<ControlEnv> {
	const { services } = options;
	const routes = new Hono<ControlEnv>();

	routes.route("/", createHealthRoutes());
	routes.route("/", createStateRoutes({ state: services.state, reset: services.reset }));
	routes.route("/", createSnapshotRoutes({ snapshots: services.snapshots }));
	routes.route("/", createContactRoutes({ contacts: services.contacts }));
	routes.route("/", createConversationRoutes({ conversations: services.conversations }));
	routes.route("/", createInboundRoutes({ inbound: services.inbound, media: services.media }));
	routes.route("/", createMediaRoutes({ media: services.media, uploads: services.uploads }));
	routes.route("/", createMessageRoutes({ statusLadder: services.statusLadder }));
	routes.route(
		"/",
		createTemplateRoutes({ templates: services.templates, templateLifecycle: services.templateLifecycle }),
	);
	routes.route("/", createTypingRoutes({ typing: services.typing }));
	routes.route("/", createInjectionRoutes({ injection: services.injection }));
	routes.route("/", createTokenRoutes({ tokens: services.tokens }));
	routes.route("/", createWebhookRoutes({ webhooks: services.webhooks, accountEvents: services.accountEvents }));
	routes.route(
		"/",
		createPhoneNumberRoutes({ phoneNumbers: services.phoneNumbers, businessProfiles: services.businessProfiles }),
	);
	routes.route("/", createWabaRoutes({ wabas: services.wabas }));
	routes.route("/", createWsRoutes({ events: services.events, logger: options.logger }));

	routes.onError(createControlErrorHandler());

	return routes;
}
