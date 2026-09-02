import { z } from "zod";

/**
 * Deterministic error injection (SPEC §4, "Error simulation").
 *
 * A rule says **where** to fail (an endpoint class), **when** to fail (always, the next N
 * requests, or every Nth), and **what** to answer with (a Meta-shaped preset). Nothing here is
 * probabilistic — the golden rule holds: a rule that has not been armed never fires, and an
 * armed one fires on exactly the requests its trigger names.
 */

/**
 * The endpoint classes a rule can target. These name **routes**, not intentions:
 * `messages.send` is `POST /{phoneNumberId}/messages`, which is also the path Meta overloads
 * with read receipts (SPEC §2.18), and `media.resolve` is the descriptor hop
 * `GET /{mediaId}?phone_number_id=` rather than every `GET /{id}`.
 *
 * `graph.all` matches every request the injection middleware sees, the media byte endpoint
 * included.
 */
export const INJECTION_TARGETS = [
	"messages.send",
	"media.upload",
	"media.resolve",
	"media.download",
	"templates.create",
	"templates.list",
	"graph.all",
] as const;

export const injectionTargetSchema = z.enum(INJECTION_TARGETS);

export type InjectionTarget = z.infer<typeof injectionTargetSchema>;

export const INJECTION_TRIGGER_KINDS = ["always", "next", "every"] as const;

export const injectionTriggerKindSchema = z.enum(INJECTION_TRIGGER_KINDS);

export type InjectionTriggerKind = z.infer<typeof injectionTriggerKindSchema>;

/** High enough for "fail the rest of this test run", low enough to stay a typo guard. */
export const MAX_TRIGGER_COUNT = 10_000;

/**
 * When a matching request fails.
 *
 * - `always` — every request the target matches.
 * - `next` — the next `count` matching requests, with a countdown the control plane serves.
 * - `every` — every `nth` matching request, counted from the rule's own request counter, so
 *   `nth: 3` fires on the 3rd, 6th and 9th request and nothing in between.
 */
export const injectionTriggerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("always") }),
	z.object({ kind: z.literal("next"), count: z.int().min(1).max(MAX_TRIGGER_COUNT) }),
	z.object({ kind: z.literal("every"), nth: z.int().min(1).max(MAX_TRIGGER_COUNT) }),
]);

export type InjectionTrigger = z.infer<typeof injectionTriggerSchema>;

/**
 * The response presets, all of them real Meta failures:
 *
 * - `rate_limit_429` — HTTP 429, code `130429`, with `Retry-After` and
 *   `X-Business-Use-Case-Usage` (SPEC §1.11).
 * - `throughput_131056` — HTTP 400, code `131056`, the (business, consumer) pair rate limit.
 * - `spam_rate_4` — HTTP 429, code `4`, the app-level request limit; carries the same two
 *   throttling headers.
 * - `server_error_500` — HTTP 500, code `1`.
 * - `custom` — the caller writes the envelope itself.
 */
export const INJECTION_PRESETS = [
	"rate_limit_429",
	"throughput_131056",
	"spam_rate_4",
	"server_error_500",
	"custom",
] as const;

export const injectionPresetSchema = z.enum(INJECTION_PRESETS);

export type InjectionPreset = z.infer<typeof injectionPresetSchema>;

/** `Retry-After`, in delta-seconds, when a preset does not say otherwise. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** `estimated_time_to_regain_access`, in **minutes**, when a preset does not say otherwise. */
export const DEFAULT_REGAIN_ACCESS_MINUTES = 15;

/** A day of `Retry-After` is already far past anything a consumer would wait out. */
const MAX_RETRY_AFTER_SECONDS = 86_400;
/** A week of `estimated_time_to_regain_access`, which is Meta's own worst case. */
const MAX_REGAIN_ACCESS_MINUTES = 10_080;

/** The `custom` preset: every field of the envelope, spelled out by the caller. */
export const injectionCustomResponseSchema = z.object({
	httpStatus: z.int().min(400).max(599),
	code: z.int().min(0).max(10_000_000),
	subcode: z.int().min(0).max(10_000_000).optional(),
	message: z.string().min(1).max(500),
	/** Fills `error_data.details`; its presence is what makes `error_data` appear (SPEC §1.4). */
	details: z.string().min(1).max(500).optional(),
	/** `error.type`; defaults to `OAuthException` like every other whaloc envelope. */
	type: z.string().min(1).max(80).optional(),
});

export type InjectionCustomResponse = z.infer<typeof injectionCustomResponseSchema>;

/** What a caller writes and what the control plane serves back, minus the bookkeeping. */
const injectionRuleShape = {
	target: injectionTargetSchema,
	trigger: injectionTriggerSchema,
	preset: injectionPresetSchema,
	/** `Retry-After` in delta-seconds; only the two 429 presets emit it. */
	retryAfterSeconds: z.int().min(0).max(MAX_RETRY_AFTER_SECONDS).optional(),
	/** `X-Business-Use-Case-Usage.estimated_time_to_regain_access`, in **minutes** (SPEC §1.11). */
	regainAccessMinutes: z.int().min(0).max(MAX_REGAIN_ACCESS_MINUTES).optional(),
	custom: injectionCustomResponseSchema.optional(),
};

/** `POST /api/injection-rules`. */
export const injectionRuleCreateRequestSchema = z
	.object(injectionRuleShape)
	.refine(value => (value.preset === "custom") === (value.custom !== undefined), {
		error: "custom is required for the custom preset, and not allowed for any other",
		path: ["custom"],
	});

export type InjectionRuleCreateRequest = z.infer<typeof injectionRuleCreateRequestSchema>;

export const injectionRuleSchema = z.object({
	id: z.string(),
	...injectionRuleShape,
	/** Matching requests this rule has seen, whether or not it fired on them. */
	seen: z.number().int().nonnegative(),
	/** Responses it actually injected. */
	matches: z.number().int().nonnegative(),
	/** The live countdown of a `next` trigger; `null` for the other two. */
	remaining: z.number().int().nonnegative().nullable(),
	/** A `next` rule that has run out. It stays listed — and inert — until it is deleted. */
	exhausted: z.boolean(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type InjectionRule = z.infer<typeof injectionRuleSchema>;

export const injectionRuleResponseSchema = z.object({ data: injectionRuleSchema });

export type InjectionRuleResponse = z.infer<typeof injectionRuleResponseSchema>;

export const injectionRuleListResponseSchema = z.object({ data: z.array(injectionRuleSchema) });

export type InjectionRuleListResponse = z.infer<typeof injectionRuleListResponseSchema>;

/** Whether a rule can still fire — what the UI's "armed" badge counts. */
export function isRuleArmed(rule: InjectionRule): boolean {
	return !rule.exhausted;
}
