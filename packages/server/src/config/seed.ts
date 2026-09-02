import { userIdSchema } from "@whaloc/shared";
import { z } from "zod";

/** Meta ids are numeric strings; ids omitted from the seed are generated deterministically. */
const metaIdSchema = z.string().regex(/^\d{1,32}$/, "must be a string of 1-32 digits");

export const QUALITY_RATINGS = ["GREEN", "YELLOW", "RED", "UNKNOWN"] as const;
export const THROUGHPUT_LEVELS = ["STANDARD", "HIGH"] as const;

/**
 * The template vocabulary a seed can set. It lives here, next to the other enums seeding
 * chooses from, because `WHALOC_SEED` is parsed before anything else exists; `db/schema.ts`
 * takes the types from here the way it already does for quality ratings.
 *
 * `TEMPLATE_STATUSES` is deliberately not one of them: a seeded template is `APPROVED` by
 * definition (SPEC §7), so a seed never names a status.
 */
export const TEMPLATE_CATEGORIES = ["AUTHENTICATION", "MARKETING", "UTILITY"] as const;
export const TEMPLATE_PARAMETER_FORMATS = ["POSITIONAL", "NAMED"] as const;

export type QualityRating = (typeof QUALITY_RATINGS)[number];
export type ThroughputLevel = (typeof THROUGHPUT_LEVELS)[number];
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export type TemplateParameterFormat = (typeof TEMPLATE_PARAMETER_FORMATS)[number];

/** Meta's rule, quoted from the OpenAPI spec: "lowercase alphanumeric and underscores only". */
export const TEMPLATE_NAME_PATTERN = /^[\da-z_]{1,512}$/;

/** `en`, `en_US`, `pt_BR`, `zh_HK` — a language, optionally with a region. */
export const TEMPLATE_LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Za-z\d]{2,4})?$/;

/**
 * A template's components: an array of objects whaloc stores and echoes verbatim (SPEC §2.7).
 * Both `POST /{wabaId}/message_templates` (`domain/template-requests.ts`) and a `WHALOC_SEED`
 * template validate against this one shape, so a template that can be seeded is a template
 * that could have been created through the Graph API.
 */
export const templateComponentsSchema = z.array(z.record(z.string(), z.unknown())).min(1);

/** What a seeded template says when the seed leaves its components out. */
const DEFAULT_TEMPLATE_COMPONENTS = [{ type: "BODY", text: "This is a whaloc test template." }];

export const seedContactSchema = z.object({
	waId: z.string().regex(/^\d{1,20}$/, "must be a string of 1-20 digits"),
	name: z.string().min(1),
	/** Business-scoped user id (SPEC §1.15); a contact carrying one puts the identity fields on its webhooks. */
	userId: userIdSchema.optional(),
});

export const seedPhoneNumberSchema = z.object({
	id: metaIdSchema.optional(),
	displayPhoneNumber: z.string().min(1),
	verifiedName: z.string().min(1).optional(),
	qualityRating: z.enum(QUALITY_RATINGS).optional(),
	throughputLevel: z.enum(THROUGHPUT_LEVELS).optional(),
});

/**
 * A template a WABA already owns. Only the name is required: a template that exists is mostly
 * defaults, and the point of seeding one is a `type: "template"` send that works against a cold
 * whaloc without creating and approving anything first (SPEC §7).
 *
 * `parameterFormat` defaults to `NAMED` rather than the `POSITIONAL` a Graph API creation
 * defaults to, because a seeded template is usually parameterless and `NAMED` is what Meta's
 * own console produces today.
 */
export const seedTemplateSchema = z.object({
	id: metaIdSchema.optional(),
	name: z.string().regex(TEMPLATE_NAME_PATTERN, "must contain only lowercase letters, digits and underscores"),
	language: z.string().regex(TEMPLATE_LANGUAGE_PATTERN, "must be a language code such as en_US").default("en"),
	category: z.enum(TEMPLATE_CATEGORIES).default("UTILITY"),
	parameterFormat: z.enum(TEMPLATE_PARAMETER_FORMATS).default("NAMED"),
	components: templateComponentsSchema.default(DEFAULT_TEMPLATE_COMPONENTS),
});

export const seedWabaSchema = z.object({
	id: metaIdSchema.optional(),
	name: z.string().min(1).optional(),
	phoneNumbers: z.array(seedPhoneNumberSchema).min(1),
	contacts: z.array(seedContactSchema).default([]),
	templates: z.array(seedTemplateSchema).default([]),
});

/** Shape of `WHALOC_SEED` (SPEC §7). */
export const seedSchema = z.array(seedWabaSchema).min(1);

export type Seed = z.infer<typeof seedSchema>;
export type SeedWaba = z.infer<typeof seedWabaSchema>;
export type SeedPhoneNumber = z.infer<typeof seedPhoneNumberSchema>;
export type SeedContact = z.infer<typeof seedContactSchema>;
export type SeedTemplate = z.infer<typeof seedTemplateSchema>;

/**
 * Built-in seed: one WABA, one phone number, two contacts, one template (SPEC §7).
 *
 * The ids derived from these values are a contract: downstream compose seeds pin WABA
 * `666635535888644`, phone number `573542517421694` and template `355867425910125`
 * (docs/integrating.md), and a consumer that seeds its own database with them only notices a
 * mismatch at send time. Changing any natural key here — a WABA's name, a phone number's digits,
 * a template's name or language — changes the derived ids; update the consumers in lockstep.
 *
 * So is the state a seeded number comes up in: `CONNECTED` and `VERIFIED`, which is what opens
 * the send gate (SPEC §4). Seeding never names those fields — the repository's defaults do —
 * so a seed stays a description of numbers that are already onboarded.
 *
 * `hello_whaloc` is the same idea applied to templates: it is `APPROVED` from the first instant,
 * takes no parameters, and is therefore sendable with nothing but a name and a language.
 */
export const DEFAULT_SEED: Seed = [
	{
		name: "whaloc Test Business",
		phoneNumbers: [
			{
				displayPhoneNumber: "+55 11 91234-5678",
				verifiedName: "whaloc Test Business",
				qualityRating: "GREEN",
				throughputLevel: "STANDARD",
			},
		],
		// One BSUID of each shape the consumer pattern allows (with and without `ENT.`), so both
		// branches of BSUID handling are exercised out of the box.
		contacts: [
			{ waId: "5571990000001", name: "Ana Souza", userId: "BR.ENT.AnaSouza01" },
			{ waId: "5571990000002", name: "Bruno Lima", userId: "BR.BrunoLima01" },
		],
		templates: [
			{
				name: "hello_whaloc",
				language: "en",
				category: "UTILITY",
				parameterFormat: "NAMED",
				components: [
					{ type: "BODY", text: "Hello from whaloc! This template is seeded, approved and takes no parameters." },
				],
			},
		],
	},
];
