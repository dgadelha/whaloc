import type { z } from "zod";
import { appConfigSchema, type AppConfig } from "./app-config.ts";

const ENV_PREFIX = "WHALOC_";

export type ParseConfigResult = { success: true; config: AppConfig } | { success: false; errors: string[] };

/**
 * Keeps only whaloc's own variables and treats blank ones as unset, so an empty
 * `WHALOC_WEBHOOK_URL=` in a compose file behaves like an absent variable instead of
 * failing validation. Values are trimmed (secrets read from files often carry a newline).
 */
function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const normalized: Record<string, string> = {};

	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || !key.startsWith(ENV_PREFIX)) {
			continue;
		}

		const trimmed = value.trim();

		if (trimmed !== "") {
			normalized[key] = trimmed;
		}
	}

	return normalized;
}

function formatIssues(error: z.ZodError): string[] {
	return error.issues.map(issue => {
		const path = issue.path.map(String).join(".");

		return path === "" ? issue.message : `${path}: ${issue.message}`;
	});
}

/**
 * Parses the environment once at boot. Never throws: the caller decides how to report the
 * (complete) list of problems and how to exit.
 */
export function parseConfig(env: NodeJS.ProcessEnv): ParseConfigResult {
	const result = appConfigSchema.safeParse(normalizeEnv(env));

	return result.success
		? { success: true, config: result.data }
		: { success: false, errors: formatIssues(result.error) };
}

/**
 * The `WHALOC_S3_*` variables, named here because a `local` backend drops them during parsing:
 * a bucket nobody reads leaves no trace in {@link AppConfig} to warn about.
 */
const S3_ENV_KEYS = [
	"WHALOC_S3_BUCKET",
	"WHALOC_S3_REGION",
	"WHALOC_S3_ENDPOINT",
	"WHALOC_S3_ACCESS_KEY_ID",
	"WHALOC_S3_SECRET_ACCESS_KEY",
	"WHALOC_S3_FORCE_PATH_STYLE",
] as const;

/**
 * Configuration that is valid but leaves a feature disabled — logged loudly at boot. `env` is
 * the raw environment, for the handful of variables the parsed config does not carry.
 */
export function collectConfigWarnings(config: AppConfig, env: NodeJS.ProcessEnv = {}): string[] {
	const warnings: string[] = [];

	if (config.webhookUrl === undefined) {
		warnings.push(
			"WHALOC_WEBHOOK_URL is not set: webhook delivery is disabled, nothing will be sent to the app under test",
		);
	} else if (config.appSecret === undefined) {
		warnings.push(
			"WHALOC_APP_SECRET is not set: webhook deliveries will be sent without an X-Hub-Signature-256 header",
		);
	}

	if (config.verifyOnStart && config.webhookVerifyToken === undefined) {
		warnings.push(
			"WHALOC_VERIFY_ON_START is enabled but WHALOC_WEBHOOK_VERIFY_TOKEN is not set: the handshake cannot run",
		);
	}

	// A configured bucket that nothing reads is the kind of mistake that only surfaces when
	// somebody goes looking for objects that were never written (SPEC §6).
	if (config.mediaBackend === "local" && S3_ENV_KEYS.some(key => (env[key] ?? "").trim() !== "")) {
		warnings.push(
			'WHALOC_S3_* is set but WHALOC_MEDIA_BACKEND is not "s3": media bytes go to WHALOC_MEDIA_DIR and the bucket is ignored',
		);
	}

	if (config.s3 !== undefined && config.s3.credentials === undefined) {
		warnings.push(
			"WHALOC_S3_ACCESS_KEY_ID / WHALOC_S3_SECRET_ACCESS_KEY are not set: the AWS SDK's default credential chain will be used",
		);
	}

	return warnings;
}

/** Boot-time summary for the logs: counts instead of the whole seed, secrets never printed. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
	let phoneNumbers = 0;
	let contacts = 0;
	let templates = 0;

	for (const waba of config.seed) {
		phoneNumbers += waba.phoneNumbers.length;
		contacts += waba.contacts.length;
		templates += waba.templates.length;
	}

	return {
		port: config.port,
		host: config.host,
		publicUrl: config.publicUrl,
		webhookUrl: config.webhookUrl ?? null,
		appSecret: config.appSecret === undefined ? "unset" : "set",
		webhookVerifyToken: config.webhookVerifyToken === undefined ? "unset" : "set",
		verifyOnStart: config.verifyOnStart,
		statusDelays: config.statusDelays,
		templateAutoApproveMs: config.templateAutoApproveMs,
		// Counted, never printed: the registry is a list of credentials (SPEC §1.9).
		tokens: config.tokens === undefined ? "unset" : { registered: config.tokens.length },
		mediaTtlSeconds: config.mediaTtlSeconds ?? null,
		dbPath: config.dbPath,
		mediaBackend: config.mediaBackend,
		mediaDir: config.mediaDir,
		// The bucket and where it lives, never the keys that open it (SPEC §6).
		s3:
			config.s3 === undefined
				? null
				: {
						bucket: config.s3.bucket,
						region: config.s3.region,
						endpoint: config.s3.endpoint ?? null,
						forcePathStyle: config.s3.forcePathStyle,
						credentials: config.s3.credentials === undefined ? "default-chain" : "configured",
					},
		webDir: config.webDir,
		logLevel: config.logLevel,
		seed: { wabas: config.seed.length, phoneNumbers, contacts, templates },
	};
}
