import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import { createServices } from "./composition.ts";
import { collectConfigWarnings, describeConfig, parseConfig } from "./config/index.ts";
import { registerShutdownHandlers } from "./graceful-shutdown.ts";
import { createLogger } from "./logging/index.ts";

const configResult = parseConfig(process.env);

if (!configResult.success) {
	const details = configResult.errors.map(error => `  - ${error}`).join("\n");

	process.stderr.write(`whaloc cannot start, the environment is invalid:\n${details}\n`);
	process.exit(1);
}

const { config } = configResult;
const logger = createLogger(config);

for (const warning of collectConfigWarnings(config, process.env)) {
	logger.warn(warning);
}

logger.info(describeConfig(config), "configuration loaded");

// config → logger → database (migrate + seed) → app → listen.
let services;

try {
	services = await createServices({ config, logger });
} catch (error) {
	logger.fatal({ err: error }, "whaloc cannot start, the database is unusable");
	process.exit(1);
}

const app = createApp({ logger, config, services: services.domain });
// `@hono/node-server` handles the WebSocket upgrade itself when it is given a `noServer`
// server; `control-api/ws-routes.ts` answers `GET /api/ws` through it (SPEC §5).
const webSocketServer = new WebSocketServer({ noServer: true });

const server = serve(
	{ fetch: app.fetch, hostname: config.host, port: config.port, websocket: { server: webSocketServer } },
	address => {
		logger.info(`whaloc listening on http://${address.address}:${String(address.port)}`);
	},
);

// The handshake is a startup nicety, never a startup requirement: whaloc is useful even when
// the app under test is not up yet (SPEC §1.13).
if (config.verifyOnStart) {
	services.domain.tasks.run(() => services.domain.webhooks.handshake());
}

registerShutdownHandlers({
	logger,
	close: async () => {
		webSocketServer.close();

		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});

		await services.close();
	},
});
