import { z } from "zod";
import {
	TEMPLATE_CATEGORIES,
	TEMPLATE_LANGUAGE_PATTERN,
	TEMPLATE_NAME_PATTERN,
	TEMPLATE_PARAMETER_FORMATS,
	templateComponentsSchema,
} from "../config/index.ts";

/**
 * Request bodies of the template management endpoints (SPEC §2.7, §2.9).
 *
 * The field shapes themselves — Meta's name and language rules, the component array — come from
 * `config/seed.ts`, which validates the templates in `WHALOC_SEED` with the very same ones: a
 * seeded template and a created one are the same object described in two places.
 */

export const templateCreateRequestSchema = z.object({
	name: z.string().regex(TEMPLATE_NAME_PATTERN, "must contain only lowercase letters, digits and underscores"),
	language: z.string().regex(TEMPLATE_LANGUAGE_PATTERN, "must be a language code such as en_US"),
	category: z.enum(TEMPLATE_CATEGORIES),
	components: templateComponentsSchema,
	/** Positional `{{1}}` placeholders unless the template says otherwise (SPEC §2). */
	parameter_format: z.enum(TEMPLATE_PARAMETER_FORMATS).default("POSITIONAL"),
});

export const templateEditRequestSchema = z
	.object({
		components: templateComponentsSchema.optional(),
		category: z.enum(TEMPLATE_CATEGORIES).optional(),
	})
	.refine(
		request => request.components !== undefined || request.category !== undefined,
		"Param components is required, or category",
	);

export type TemplateCreateRequest = z.infer<typeof templateCreateRequestSchema>;
export type TemplateEditRequest = z.infer<typeof templateEditRequestSchema>;
