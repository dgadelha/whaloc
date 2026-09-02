import { Hono } from "hono";
import type {
	BusinessProfileService,
	InjectionService,
	MediaService,
	MessageService,
	ObjectService,
	PhoneNumberService,
	ReadReceiptService,
	SubscribedAppService,
	TemplateService,
	TokenRegistry,
	UploadService,
} from "../domain/index.ts";
import { createBearerAuth } from "./bearer-auth.ts";
import { createBusinessProfileRoutes } from "./business-profile-routes.ts";
import { createGraphContext, type GraphEnv } from "./graph-env.ts";
import { createInjectionMiddleware } from "./injection.ts";
import { createMediaRoutes } from "./media-routes.ts";
import { createMessageRoutes } from "./message-routes.ts";
import { createGraphErrorHandler } from "./meta-error-envelope.ts";
import { createObjectRoutes } from "./object-routes.ts";
import { createPhoneNumberRoutes } from "./phone-number-routes.ts";
import { createSubscribedAppRoutes } from "./subscribed-app-routes.ts";
import { createTemplateRoutes } from "./template-routes.ts";
import { createUploadRoutes } from "./upload-routes.ts";

export interface GraphRoutesOptions {
	objects: ObjectService;
	messages: MessageService;
	readReceipts: ReadReceiptService;
	media: MediaService;
	uploads: UploadService;
	templates: TemplateService;
	phoneNumbers: PhoneNumberService;
	businessProfiles: BusinessProfileService;
	subscribedApps: SubscribedAppService;
	/** Error simulation (SPEC §4): the token gate and the injection rules. */
	tokens: TokenRegistry;
	injection: InjectionService;
	publicUrl: string;
}

/**
 * The whole Graph API mock, as one router (SPEC §2). {@link createApp} mounts it under
 * `/:version{v\d+\.\d+}` so every version answers identically.
 *
 * Route order is cosmetic **except for the uploads router**, which has to come before the
 * template one: `POST /upload:<opaque>` (SPEC §2.21) is one segment deep and would otherwise be
 * taken by the template edit's `POST /{templateId}`. Nothing else overlaps — the object read, the
 * template edit and the media delete are one segment deep on different methods, and the rest are
 * two segments whose second segment is a literal (`messages`, `media`, `uploads`,
 * `message_templates`, `phone_numbers`, `request_code`, `verify_code`, `register`, `deregister`,
 * `whatsapp_business_profile`, `subscribed_apps`), which a router matches ahead of a parameter.
 *
 * The error handler is registered here rather than on the app so that the Meta envelope stays
 * a property of *this* surface; the control plane keeps its own, plainer error shape (SPEC §8).
 */
export function createGraphRoutes(options: GraphRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	// Order is behavior, not taste: the context first so everything downstream has a request id,
	// then authentication, then injection — an armed rule must not be able to hide a 401.
	routes.use(createGraphContext());
	routes.use(createBearerAuth({ tokens: options.tokens }));
	routes.use(createInjectionMiddleware({ injection: options.injection }));

	// Before the template router: see the note above about `POST /upload:<opaque>`.
	routes.route("/", createUploadRoutes({ uploads: options.uploads, media: options.media }));
	routes.route("/", createObjectRoutes({ objects: options.objects, media: options.media }));
	routes.route("/", createMessageRoutes({ messages: options.messages, readReceipts: options.readReceipts }));
	routes.route("/", createMediaRoutes({ media: options.media }));
	routes.route("/", createPhoneNumberRoutes({ phoneNumbers: options.phoneNumbers, objects: options.objects }));
	routes.route("/", createBusinessProfileRoutes({ businessProfiles: options.businessProfiles }));
	routes.route("/", createSubscribedAppRoutes({ subscribedApps: options.subscribedApps }));
	routes.route(
		"/",
		createTemplateRoutes({
			templates: options.templates,
			publicUrl: options.publicUrl,
		}),
	);

	routes.onError(createGraphErrorHandler());

	return routes;
}
