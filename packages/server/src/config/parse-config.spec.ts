import path from "node:path";
import { describe, expect, it } from "vitest";
import { anyString } from "../testing/expectations.ts";
import { DEFAULT_SEED, DEFAULT_WEB_DIR, type AppConfig } from "./index.ts";
import { collectConfigWarnings, describeConfig, parseConfig } from "./parse-config.ts";

function parseOrThrow(env: NodeJS.ProcessEnv): AppConfig {
	const result = parseConfig(env);

	if (!result.success) {
		throw new Error(`expected a valid configuration, got:\n${result.errors.join("\n")}`);
	}

	return result.config;
}

function errorsOf(env: NodeJS.ProcessEnv): string[] {
	const result = parseConfig(env);

	if (result.success) {
		throw new Error("expected the configuration to be rejected");
	}

	return result.errors;
}

describe("parseConfig", () => {
	describe("defaults", () => {
		it("applies every documented default when nothing is set", () => {
			const config = parseOrThrow({});

			expect(config).toMatchObject({
				port: 8080,
				host: "0.0.0.0",
				publicUrl: "http://localhost:8080",
				webhookUrl: undefined,
				appSecret: undefined,
				webhookVerifyToken: undefined,
				verifyOnStart: false,
				// Unset: `SubscribedAppService` derives a stable id instead (SPEC §2.20).
				appId: undefined,
				statusDelays: { sent: 0, delivered: 800, read: null },
				templateAutoApproveMs: 2000,
				dbPath: ":memory:",
				mediaDir: "./data/media",
				webDir: DEFAULT_WEB_DIR,
				logLevel: "info",
			});
			expect(config.seed).toEqual(DEFAULT_SEED);
		});

		it("resolves a relative web directory against the working directory", () => {
			const config = parseOrThrow({ WHALOC_WEB_DIR: "./public" });

			expect(config.webDir).toBe(path.resolve("./public"));
		});

		it("ignores variables that are set to an empty or blank string", () => {
			const config = parseOrThrow({ WHALOC_WEBHOOK_URL: "", WHALOC_APP_SECRET: " ".repeat(3) });

			expect(config.webhookUrl).toBeUndefined();
			expect(config.appSecret).toBeUndefined();
		});

		it("ignores environment variables that are not whaloc's", () => {
			const config = parseOrThrow({ PORT: "3000", NODE_ENV: "production" });

			expect(config.port).toBe(8080);
		});
	});

	describe("network settings", () => {
		it("parses the port and bind address", () => {
			const config = parseOrThrow({ WHALOC_PORT: "3010", WHALOC_HOST: "127.0.0.1" });

			expect(config).toMatchObject({ port: 3010, host: "127.0.0.1" });
		});

		it.each(["0", "70000", "8080.5", "-1", "eighty"])("rejects the invalid port %j", port => {
			expect(errorsOf({ WHALOC_PORT: port })).toHaveLength(1);
		});

		it("explains why a port is invalid", () => {
			expect(errorsOf({ WHALOC_PORT: "eighty" })).toEqual(["WHALOC_PORT: must be a whole number"]);
		});

		it("strips trailing slashes from the public URL", () => {
			const config = parseOrThrow({ WHALOC_PUBLIC_URL: "http://whaloc:8080//" });

			expect(config.publicUrl).toBe("http://whaloc:8080");
		});

		it("rejects a public URL that is not a URL", () => {
			expect(errorsOf({ WHALOC_PUBLIC_URL: "whaloc:8080" })).toHaveLength(1);
		});
	});

	describe("webhook settings", () => {
		it("keeps the webhook target, secret and verify token", () => {
			const config = parseOrThrow({
				WHALOC_WEBHOOK_URL: "http://meta-webhook-receiver:3001/meta-webhooks",
				WHALOC_APP_SECRET: "dev-meta-app-secret",
				WHALOC_WEBHOOK_VERIFY_TOKEN: "dev-verify-token",
				WHALOC_VERIFY_ON_START: "true",
			});

			expect(config).toMatchObject({
				webhookUrl: "http://meta-webhook-receiver:3001/meta-webhooks",
				appSecret: "dev-meta-app-secret",
				webhookVerifyToken: "dev-verify-token",
				verifyOnStart: true,
			});
		});

		it.each([
			["true", true],
			["1", true],
			["yes", true],
			["false", false],
			["0", false],
		])("reads WHALOC_VERIFY_ON_START=%s as %s", (raw, expected) => {
			expect(parseOrThrow({ WHALOC_VERIFY_ON_START: raw }).verifyOnStart).toBe(expected);
		});

		it("rejects a non-boolean WHALOC_VERIFY_ON_START", () => {
			expect(errorsOf({ WHALOC_VERIFY_ON_START: "maybe" })).toHaveLength(1);
		});

		it("keeps a configured app id, and rejects one that is not digits", () => {
			expect(parseOrThrow({ WHALOC_APP_ID: "1234567890" }).appId).toBe("1234567890");
			// Blank counts as unset, like every other variable.
			expect(parseOrThrow({ WHALOC_APP_ID: "  " }).appId).toBeUndefined();
			expect(errorsOf({ WHALOC_APP_ID: "app-1" })).toHaveLength(1);
		});
	});

	describe("status delays", () => {
		it("parses the ladder and leaves read receipts manual", () => {
			const config = parseOrThrow({ WHALOC_STATUS_DELAYS: "sent:10,delivered:1500" });

			expect(config.statusDelays).toEqual({ sent: 10, delivered: 1500, read: null });
		});

		it("automates read receipts when a read delay is given", () => {
			const config = parseOrThrow({ WHALOC_STATUS_DELAYS: "sent:0,delivered:800,read:2500" });

			expect(config.statusDelays).toEqual({ sent: 0, delivered: 800, read: 2500 });
		});

		it("falls back to the default delay for steps that are omitted", () => {
			const config = parseOrThrow({ WHALOC_STATUS_DELAYS: "read:100" });

			expect(config.statusDelays).toEqual({ sent: 0, delivered: 800, read: 100 });
		});

		it.each(["sent", "sent:", "sent:abc", "opened:10", "sent:10;delivered:20"])(
			"rejects the malformed ladder %j",
			delays => {
				expect(errorsOf({ WHALOC_STATUS_DELAYS: delays })).toHaveLength(1);
			},
		);
	});

	describe("template auto approval", () => {
		it("parses the delay in milliseconds", () => {
			expect(parseOrThrow({ WHALOC_TEMPLATE_AUTO_APPROVE: "500" }).templateAutoApproveMs).toBe(500);
		});

		it('turns approval manual when set to "off"', () => {
			expect(parseOrThrow({ WHALOC_TEMPLATE_AUTO_APPROVE: "off" }).templateAutoApproveMs).toBeNull();
		});

		it("rejects anything else", () => {
			expect(errorsOf({ WHALOC_TEMPLATE_AUTO_APPROVE: "later" })).not.toHaveLength(0);
		});
	});

	describe("token registry (SPEC §1.9)", () => {
		it("is unset by default, which is permissive auth", () => {
			expect(parseOrThrow({}).tokens).toBeUndefined();
		});

		it("splits a comma-separated list, trimming and dropping blanks", () => {
			expect(parseOrThrow({ WHALOC_TOKENS: " one , two,,three, " }).tokens).toEqual(["one", "two", "three"]);
		});

		it("takes a single token", () => {
			expect(parseOrThrow({ WHALOC_TOKENS: "EAAonly" }).tokens).toEqual(["EAAonly"]);
		});

		it("rejects a list that is only separators, and one that repeats a token", () => {
			expect(errorsOf({ WHALOC_TOKENS: ",,," })).not.toHaveLength(0);
			expect(errorsOf({ WHALOC_TOKENS: "same,same" })).not.toHaveLength(0);
		});

		it("counts the tokens in the boot summary and never prints them", () => {
			const described = describeConfig(parseOrThrow({ WHALOC_TOKENS: "EAAsecret-one,EAAsecret-two" }));

			expect(described["tokens"]).toEqual({ registered: 2 });
			expect(JSON.stringify(described)).not.toContain("EAAsecret");
		});
	});

	describe("media TTL (SPEC §4)", () => {
		it("is off by default", () => {
			expect(parseOrThrow({}).mediaTtlSeconds).toBeUndefined();
		});

		it("parses a whole number of seconds", () => {
			expect(parseOrThrow({ WHALOC_MEDIA_TTL_SECONDS: "30" }).mediaTtlSeconds).toBe(30);
		});

		it.each(["0", "-1", "1.5", "thirty"])("rejects %o", value => {
			expect(errorsOf({ WHALOC_MEDIA_TTL_SECONDS: value })).not.toHaveLength(0);
		});
	});

	describe("media backend (SPEC §6)", () => {
		const S3_MINIMUM = { WHALOC_MEDIA_BACKEND: "s3", WHALOC_S3_BUCKET: "whaloc", WHALOC_S3_REGION: "us-east-1" };

		it("stores media in a directory unless told otherwise", () => {
			const config = parseOrThrow({});

			expect(config.mediaBackend).toBe("local");
			expect(config.s3).toBeUndefined();
		});

		it("resolves the S3 settings when the backend is s3", () => {
			const config = parseOrThrow({
				...S3_MINIMUM,
				WHALOC_S3_ENDPOINT: "http://minio:9000",
				WHALOC_S3_ACCESS_KEY_ID: "whaloc",
				WHALOC_S3_SECRET_ACCESS_KEY: "whaloc-secret",
			});

			expect(config.mediaBackend).toBe("s3");
			expect(config.s3).toEqual({
				bucket: "whaloc",
				region: "us-east-1",
				endpoint: "http://minio:9000",
				// An endpoint means an S3-compatible server, and those are path-style.
				forcePathStyle: true,
				credentials: { accessKeyId: "whaloc", secretAccessKey: "whaloc-secret" },
			});
		});

		it("addresses AWS itself with virtual-host style, and takes an explicit override either way", () => {
			expect(parseOrThrow(S3_MINIMUM).s3?.forcePathStyle).toBe(false);
			expect(parseOrThrow({ ...S3_MINIMUM, WHALOC_S3_FORCE_PATH_STYLE: "true" }).s3?.forcePathStyle).toBe(true);
			expect(
				parseOrThrow({ ...S3_MINIMUM, WHALOC_S3_ENDPOINT: "http://minio:9000", WHALOC_S3_FORCE_PATH_STYLE: "false" }).s3
					?.forcePathStyle,
			).toBe(false);
		});

		it("falls back to the SDK's credential chain when neither key is set", () => {
			expect(parseOrThrow(S3_MINIMUM).s3?.credentials).toBeUndefined();
		});

		it("refuses an s3 backend with no bucket and no region, naming both", () => {
			const errors = errorsOf({ WHALOC_MEDIA_BACKEND: "s3" });

			expect(errors).toHaveLength(2);
			expect(errors.join("\n")).toContain("WHALOC_S3_BUCKET");
			expect(errors.join("\n")).toContain("WHALOC_S3_REGION");
		});

		it.each([
			["WHALOC_S3_ACCESS_KEY_ID", "WHALOC_S3_SECRET_ACCESS_KEY"],
			["WHALOC_S3_SECRET_ACCESS_KEY", "WHALOC_S3_ACCESS_KEY_ID"],
		])("refuses %s without %s", (set, missing) => {
			const errors = errorsOf({ ...S3_MINIMUM, [set]: "value" });

			expect(errors).toEqual([expect.stringContaining(missing)]);
		});

		// Half a credential is a typo, not a request for the default chain — even for `local`,
		// where the variables are otherwise ignored.
		it("checks the credential pair whatever the backend is", () => {
			expect(errorsOf({ WHALOC_S3_ACCESS_KEY_ID: "whaloc" })).toEqual([
				expect.stringContaining("WHALOC_S3_SECRET_ACCESS_KEY"),
			]);
		});

		it.each(["ftp://minio:9000", "minio:9000"])("rejects the endpoint %o", endpoint => {
			expect(errorsOf({ ...S3_MINIMUM, WHALOC_S3_ENDPOINT: endpoint })).toEqual([
				expect.stringContaining("WHALOC_S3_ENDPOINT"),
			]);
		});

		it("rejects a backend that is neither local nor s3", () => {
			expect(errorsOf({ WHALOC_MEDIA_BACKEND: "gcs" })).toEqual([expect.stringContaining("WHALOC_MEDIA_BACKEND")]);
		});
	});

	describe("seed", () => {
		it("parses a JSON seed", () => {
			const config = parseOrThrow({
				WHALOC_SEED: JSON.stringify([
					{
						id: "102290129340398",
						name: "Acme",
						phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100", qualityRating: "YELLOW" }],
						contacts: [{ waId: "15550000101", name: "Jane" }],
					},
				]),
			});

			expect(config.seed).toEqual([
				{
					id: "102290129340398",
					name: "Acme",
					phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100", qualityRating: "YELLOW" }],
					contacts: [{ waId: "15550000101", name: "Jane" }],
					templates: [],
				},
			]);
		});

		it("defaults the contact and template lists of a seeded WABA", () => {
			const config = parseOrThrow({
				WHALOC_SEED: JSON.stringify([{ phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }] }]),
			});

			expect(config.seed[0]).toMatchObject({ contacts: [], templates: [] });
		});

		it("parses a seeded template and fills in everything but its name", () => {
			const config = parseOrThrow({
				WHALOC_SEED: JSON.stringify([
					{ phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }], templates: [{ name: "order_update" }] },
				]),
			});

			expect(config.seed[0]?.templates).toEqual([
				{
					name: "order_update",
					language: "en",
					category: "UTILITY",
					parameterFormat: "NAMED",
					components: [{ type: "BODY", text: anyString() }],
				},
			]);
		});

		it("keeps everything a seeded template spells out", () => {
			const config = parseOrThrow({
				WHALOC_SEED: JSON.stringify([
					{
						phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }],
						templates: [
							{
								id: "102290129340399",
								name: "order_update",
								language: "pt_BR",
								category: "MARKETING",
								parameterFormat: "POSITIONAL",
								components: [{ type: "BODY", text: "Pedido {{1}}" }],
							},
						],
					},
				]),
			});

			expect(config.seed[0]?.templates[0]).toEqual({
				id: "102290129340399",
				name: "order_update",
				language: "pt_BR",
				category: "MARKETING",
				parameterFormat: "POSITIONAL",
				components: [{ type: "BODY", text: "Pedido {{1}}" }],
			});
		});

		it.each([
			["a template without a name", { language: "en" }],
			["a template name Meta would reject", { name: "Order Update" }],
			["an unknown category", { name: "order_update", category: "TRANSACTIONAL" }],
			["a malformed language", { name: "order_update", language: "english" }],
			["an empty component list", { name: "order_update", components: [] }],
		])("rejects %s", (_case, template) => {
			const errors = errorsOf({
				WHALOC_SEED: JSON.stringify([
					{ phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }], templates: [template] },
				]),
			});

			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("WHALOC_SEED.0.templates.0.");
		});

		it("rejects a seed that is not JSON", () => {
			expect(errorsOf({ WHALOC_SEED: "[{" })).toEqual(["WHALOC_SEED: must be valid JSON"]);
		});

		it("reports the path of an invalid seed entry", () => {
			const errors = errorsOf({ WHALOC_SEED: JSON.stringify([{ phoneNumbers: [{}] }]) });

			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("WHALOC_SEED.0.phoneNumbers.0.displayPhoneNumber");
		});

		it("rejects a WABA without phone numbers", () => {
			expect(errorsOf({ WHALOC_SEED: JSON.stringify([{ phoneNumbers: [] }]) })).toHaveLength(1);
		});

		it("rejects a non-numeric WABA id", () => {
			const errors = errorsOf({
				WHALOC_SEED: JSON.stringify([{ id: "waba-1", phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }] }]),
			});

			expect(errors).toEqual(["WHALOC_SEED.0.id: must be a string of 1-32 digits"]);
		});
	});

	describe("logging", () => {
		it.each(["fatal", "error", "warn", "info", "debug", "trace", "silent"])("accepts the level %s", level => {
			expect(parseOrThrow({ WHALOC_LOG_LEVEL: level }).logLevel).toBe(level);
		});

		it("rejects an unknown level", () => {
			expect(errorsOf({ WHALOC_LOG_LEVEL: "verbose" })).toHaveLength(1);
		});
	});

	it("reports every problem at once instead of failing on the first", () => {
		const errors = errorsOf({
			WHALOC_PORT: "nope",
			WHALOC_PUBLIC_URL: "not-a-url",
			WHALOC_LOG_LEVEL: "chatty",
			WHALOC_STATUS_DELAYS: "sent:soon",
		});

		expect(errors).toHaveLength(4);
		expect(errors.join("\n")).toContain("WHALOC_PORT");
		expect(errors.join("\n")).toContain("WHALOC_PUBLIC_URL");
		expect(errors.join("\n")).toContain("WHALOC_LOG_LEVEL");
		expect(errors.join("\n")).toContain("WHALOC_STATUS_DELAYS");
	});
});

describe("collectConfigWarnings", () => {
	it("warns when webhooks are disabled", () => {
		const warnings = collectConfigWarnings(parseOrThrow({}));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("WHALOC_WEBHOOK_URL");
	});

	it("warns when deliveries would go out unsigned", () => {
		const warnings = collectConfigWarnings(parseOrThrow({ WHALOC_WEBHOOK_URL: "http://receiver:3001/hooks" }));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("WHALOC_APP_SECRET");
	});

	it("warns when the startup handshake cannot run", () => {
		const warnings = collectConfigWarnings(
			parseOrThrow({
				WHALOC_WEBHOOK_URL: "http://receiver:3001/hooks",
				WHALOC_APP_SECRET: "secret",
				WHALOC_VERIFY_ON_START: "true",
			}),
		);

		expect(warnings).toEqual([expect.stringContaining("WHALOC_WEBHOOK_VERIFY_TOKEN")]);
	});

	it("stays quiet on a fully configured environment", () => {
		const warnings = collectConfigWarnings(
			parseOrThrow({
				WHALOC_WEBHOOK_URL: "http://receiver:3001/hooks",
				WHALOC_APP_SECRET: "secret",
				WHALOC_WEBHOOK_VERIFY_TOKEN: "token",
				WHALOC_VERIFY_ON_START: "true",
			}),
		);

		expect(warnings).toEqual([]);
	});

	/** A bucket nobody reads is invisible in the parsed config, so the raw environment is checked. */
	it("warns when an S3 bucket is configured but the backend is still local", () => {
		const env = { WHALOC_S3_BUCKET: "whaloc-media", WHALOC_S3_REGION: "us-east-1" };
		const warnings = collectConfigWarnings(parseOrThrow(env), env);

		expect(warnings).toEqual([
			expect.stringContaining("WHALOC_WEBHOOK_URL"),
			expect.stringContaining("WHALOC_MEDIA_BACKEND"),
		]);
	});

	it("says when the S3 backend will fall back to the SDK's credential chain", () => {
		const env = { WHALOC_MEDIA_BACKEND: "s3", WHALOC_S3_BUCKET: "whaloc", WHALOC_S3_REGION: "us-east-1" };
		const warnings = collectConfigWarnings(parseOrThrow(env), env);

		expect(warnings).toEqual([
			expect.stringContaining("WHALOC_WEBHOOK_URL"),
			expect.stringContaining("WHALOC_S3_ACCESS_KEY_ID"),
		]);
	});
});

describe("describeConfig", () => {
	it("never prints secrets and summarises the seed", () => {
		const described = describeConfig(
			parseOrThrow({
				WHALOC_APP_SECRET: "dev-meta-app-secret",
				WHALOC_WEBHOOK_VERIFY_TOKEN: "dev-verify-token",
			}),
		);

		expect(described).toMatchObject({
			appSecret: "set",
			webhookVerifyToken: "set",
			seed: { wabas: 1, phoneNumbers: 1, contacts: 2, templates: 1 },
		});
		expect(JSON.stringify(described)).not.toContain("dev-meta-app-secret");
		expect(JSON.stringify(described)).not.toContain("dev-verify-token");
	});

	it("marks missing secrets as unset", () => {
		expect(describeConfig(parseOrThrow({}))).toMatchObject({ appSecret: "unset", webhookVerifyToken: "unset" });
	});

	it("summarises the S3 backend without printing the keys that open it", () => {
		const described = describeConfig(
			parseOrThrow({
				WHALOC_MEDIA_BACKEND: "s3",
				WHALOC_S3_BUCKET: "whaloc-media",
				WHALOC_S3_REGION: "eu-west-1",
				WHALOC_S3_ENDPOINT: "http://minio:9000",
				WHALOC_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
				WHALOC_S3_SECRET_ACCESS_KEY: "super-secret-key",
			}),
		);

		expect(described).toMatchObject({
			mediaBackend: "s3",
			s3: {
				bucket: "whaloc-media",
				region: "eu-west-1",
				endpoint: "http://minio:9000",
				forcePathStyle: true,
				credentials: "configured",
			},
		});
		expect(JSON.stringify(described)).not.toContain("super-secret-key");
		expect(JSON.stringify(described)).not.toContain("AKIAEXAMPLE");
	});

	it("reports a local backend as having no bucket", () => {
		expect(describeConfig(parseOrThrow({}))).toMatchObject({ mediaBackend: "local", s3: null });
	});
});
