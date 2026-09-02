import type { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AppEnv } from "../app-env.ts";
import { createApp } from "../app.ts";
import { createServices, type AppServices } from "../composition.ts";
import { appConfigSchema, type AppConfig } from "../config/index.ts";
import type { Scheduler } from "../domain/index.ts";

/**
 * The fixture the Graph API integration tests run against: the real composed app, on an
 * in-memory database and a throwaway media directory (SPEC §8).
 *
 * Nothing is stubbed. A test drives the app the way the consumer does — through
 * `app.request()` — so the assertions are about the bytes on the wire, envelopes included.
 */
export interface TestApp {
	app: Hono<AppEnv>;
	services: AppServices;
	config: AppConfig;
	/** Ids from the built-in seed, which is what the tests address. */
	wabaId: string;
	phoneNumberId: string;
	mediaDir: string;
	close: () => Promise<void>;
}

/** Any non-empty token is accepted (SPEC §1.9); tests use this one unless they test auth. */
export const TEST_AUTH_HEADERS = { authorization: "Bearer test-token" } as const;

/** The public base URL the fixture is configured with; media URLs and `paging.next` use it. */
export const TEST_PUBLIC_URL = "http://localhost:9999";

export interface CreateTestAppOptions {
	/**
	 * Drives every clock the services read — which is what makes the media TTL (SPEC §4)
	 * testable: rows are still stamped by the real clock, so a spec uploads, moves this one
	 * forward, and asserts on the boundary without waiting for it.
	 */
	scheduler?: Scheduler;
}

export async function createTestApp(
	env: Record<string, string> = {},
	options: CreateTestAppOptions = {},
): Promise<TestApp> {
	const mediaDir = await mkdtemp(path.join(tmpdir(), "whaloc-test-media-"));
	const config = appConfigSchema.parse({
		WHALOC_DB_PATH: ":memory:",
		WHALOC_MEDIA_DIR: mediaDir,
		WHALOC_PUBLIC_URL: TEST_PUBLIC_URL,
		WHALOC_LOG_LEVEL: "silent",
		// A directory that does not exist: the API surfaces are tested without the static UI
		// in front of them, so an unrouted path is a 404 and not the SPA fallback. The web UI
		// spec points this at a fixture instead.
		WHALOC_WEB_DIR: path.join(mediaDir, "no-web-bundle"),
		...env,
	});
	const logger = pino({ enabled: false });
	const services = await createServices({
		config,
		logger,
		...(options.scheduler !== undefined && { scheduler: options.scheduler }),
	});
	const waba = services.seed.wabas[0]!;

	return {
		app: createApp({ logger, config, services: services.domain }),
		services,
		config,
		wabaId: waba.id,
		phoneNumberId: waba.phoneNumbers[0]!.id,
		mediaDir,
		close: async () => {
			await services.close();
			await rm(mediaDir, { recursive: true, force: true });
		},
	};
}
