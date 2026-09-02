import { Hono } from "hono";
import type { AppEnv } from "./app-env.ts";
import type { DomainServices } from "./composition.ts";
import type { AppConfig } from "./config/index.ts";
import { createControlRoutes, createHealthRoutes } from "./control-api/index.ts";
import { createGraphRoutes, createMediaDownloadRoutes, GRAPH_VERSION_PATH } from "./graph-api/index.ts";
import { createRequestLogger, type Logger } from "./logging/index.ts";
import { createWebUiRoutes, hasWebUiBundle } from "./web-ui.ts";

export interface CreateAppOptions {
	logger: Logger;
	config: AppConfig;
	services: DomainServices;
}

/**
 * Composes the HTTP surfaces served on the single whaloc port: the Graph API mock, the
 * control plane (REST + WebSocket), and the media byte endpoint. The static web UI is mounted
 * here as it lands.
 */
export function createApp(options: CreateAppOptions): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use(createRequestLogger(options.logger));

	// The Docker HEALTHCHECK hits the root alias; the control plane serves its own copy.
	app.route("/", createHealthRoutes());
	app.route("/api", createControlRoutes({ services: options.services, logger: options.logger }));

	// The same router answers every `/v<major>.<minor>` prefix (SPEC §1.1); the media byte
	// endpoint sits outside it because the URLs it serves are opaque to the consumer.
	app.route(
		GRAPH_VERSION_PATH,
		createGraphRoutes({
			objects: options.services.objects,
			messages: options.services.messages,
			readReceipts: options.services.readReceipts,
			media: options.services.media,
			uploads: options.services.uploads,
			templates: options.services.templates,
			phoneNumbers: options.services.phoneNumbers,
			businessProfiles: options.services.businessProfiles,
			subscribedApps: options.services.subscribedApps,
			tokens: options.services.tokens,
			injection: options.services.injection,
			publicUrl: options.config.publicUrl,
		}),
	);
	app.route(
		"/",
		createMediaDownloadRoutes({
			media: options.services.media,
			uploads: options.services.uploads,
			injection: options.services.injection,
		}),
	);

	// Last, so every surface above keeps its paths: the UI's SPA fallback only answers what
	// nothing else claimed (SPEC §8). Without a built bundle — `npm run dev`, where Vite serves
	// the UI and proxies back here — `/` simply stays unrouted.
	if (hasWebUiBundle(options.config.webDir)) {
		app.route("/", createWebUiRoutes({ webDir: options.config.webDir }));
	} else {
		options.logger.warn(
			{ webDir: options.config.webDir },
			"no web UI bundle found: run `npm run build --workspace @whaloc/web`, or use the Vite dev server",
		);
	}

	app.onError((error, c) => {
		c.var.logger.error({ err: error }, "unhandled error while serving request");

		// Both surfaces register their own error handler; this one only sees what escaped
		// them, which is a bug in whaloc.
		return c.json({ error: { message: "Internal Server Error" } }, 500);
	});

	return app;
}
