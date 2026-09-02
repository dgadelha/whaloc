import { z } from "zod";
import {
	jsonObjectSchema,
	qualityRatingSchema,
	templateCategorySchema,
	templateParameterFormatSchema,
	templateStatusSchema,
} from "./common.ts";

/** A message template as the control plane serves it (SPEC §5). */
export const templateSchema = z.object({
	id: z.string(),
	wabaId: z.string(),
	name: z.string(),
	language: z.string(),
	category: templateCategorySchema,
	parameterFormat: templateParameterFormatSchema,
	components: z.array(jsonObjectSchema),
	status: templateStatusSchema,
	rejectedReason: z.string().nullable(),
	qualityScore: qualityRatingSchema.nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type Template = z.infer<typeof templateSchema>;

export const templateListResponseSchema = z.object({ data: z.array(templateSchema) });
export const templateResponseSchema = z.object({ data: templateSchema });

export type TemplateListResponse = z.infer<typeof templateListResponseSchema>;
export type TemplateResponse = z.infer<typeof templateResponseSchema>;

/**
 * `GET /api/templates` — the same filters the Graph listing takes (SPEC §2.8), so the UI's
 * filter bar narrows the list **server-side** and the two surfaces cannot disagree about what
 * "PENDING utility templates mentioning order" means.
 *
 * `search` is Meta's `name_or_content`: a substring of the name or of the components.
 */
export const listTemplatesQuerySchema = z.object({
	wabaId: z.string().min(1).optional(),
	status: templateStatusSchema.optional(),
	category: templateCategorySchema.optional(),
	language: z.string().min(1).optional(),
	name: z.string().min(1).optional(),
	search: z.string().min(1).optional(),
});

export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;

/** `reason` in a `message_template_status_update`, as Meta spells them. */
export const TEMPLATE_REJECTION_REASONS = [
	"ABUSIVE_CONTENT",
	"INCORRECT_CATEGORY",
	"INVALID_FORMAT",
	"PROMOTIONAL",
	"SCAM",
	"TAG_CONTENT_MISMATCH",
	"NONE",
] as const;

export const templateRejectionReasonSchema = z.enum(TEMPLATE_REJECTION_REASONS);

export type TemplateRejectionReason = z.infer<typeof templateRejectionReasonSchema>;

/** `POST /api/templates/:id/reject` — `rejection_info` is what the webhook carries verbatim. */
export const rejectTemplateRequestSchema = z.object({
	reason: templateRejectionReasonSchema.default("INVALID_FORMAT"),
	rejectionInfo: z
		.object({
			reason: z.string().min(1),
			recommendation: z.string().min(1),
		})
		.optional(),
});

export type RejectTemplateRequest = z.infer<typeof rejectTemplateRequestSchema>;

/** `POST /api/templates/:id/quality` — emits `message_template_quality_update`. */
export const templateQualityRequestSchema = z.object({
	qualityScore: qualityRatingSchema,
});

export type TemplateQualityRequest = z.infer<typeof templateQualityRequestSchema>;
