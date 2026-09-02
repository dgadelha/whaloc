import { BUSINESS_PROFILE_LIMITS, BUSINESS_VERTICALS, type BusinessProfile } from "@whaloc/shared";
import { z } from "zod";

/**
 * `GET|POST /{phoneNumberId}/whatsapp_business_profile` (SPEC §2.19).
 *
 * The vendored v25.0 specs do not cover this endpoint, so the shape is modeled on Meta's public
 * documentation: the field set, its length limits and the `vertical` enum are Meta's, and so is
 * the "only what you send changes" update semantics.
 *
 * Meta speaks snake_case here; the rest of whaloc — the stored column, the control plane and the
 * UI — speaks camelCase, so this module owns the translation in both directions.
 */

export const businessProfileUpdateSchema = z.object({
	messaging_product: z.literal("whatsapp", "Param messaging_product must be whatsapp"),
	about: z.string().max(BUSINESS_PROFILE_LIMITS.about).optional(),
	address: z.string().max(BUSINESS_PROFILE_LIMITS.address).optional(),
	description: z.string().max(BUSINESS_PROFILE_LIMITS.description).optional(),
	email: z.string().max(BUSINESS_PROFILE_LIMITS.email).optional(),
	vertical: z.enum(BUSINESS_VERTICALS, `Param vertical must be one of ${BUSINESS_VERTICALS.join(", ")}`).optional(),
	websites: z
		.array(z.string().max(BUSINESS_PROFILE_LIMITS.website))
		.max(BUSINESS_PROFILE_LIMITS.websites, `Param websites accepts at most ${String(BUSINESS_PROFILE_LIMITS.websites)}`)
		.optional(),
	/**
	 * Meta's handle for an uploaded picture: the `h` a completed Resumable Upload API session
	 * answers with (SPEC §2.21). whaloc also keeps accepting a **media id** here, which is the
	 * one-call shortcut its own docs and UI use (SPEC §2.19).
	 */
	profile_picture_handle: z.string().optional(),
});

export type BusinessProfileUpdate = z.infer<typeof businessProfileUpdateSchema>;

/** The camelCase patch the service applies; `""` clears a field, absence leaves it alone. */
export interface BusinessProfilePatch {
	about?: string;
	address?: string;
	description?: string;
	email?: string;
	websites?: string[];
	vertical?: string;
	profilePictureHandle?: string;
}

/** Meta's body → the patch the service understands. */
export function toBusinessProfilePatch(request: BusinessProfileUpdate): BusinessProfilePatch {
	return {
		...(request.about !== undefined && { about: request.about }),
		...(request.address !== undefined && { address: request.address }),
		...(request.description !== undefined && { description: request.description }),
		...(request.email !== undefined && { email: request.email }),
		...(request.websites !== undefined && { websites: request.websites }),
		...(request.vertical !== undefined && { vertical: request.vertical }),
		...(request.profile_picture_handle !== undefined && { profilePictureHandle: request.profile_picture_handle }),
	};
}

/**
 * The stored profile → the node Meta answers with, `messaging_product` always included.
 *
 * An unset field is **absent** rather than empty, which is what Meta does and what makes
 * `fields` projection mean something.
 */
export function businessProfileNode(profile: BusinessProfile): Record<string, unknown> {
	return {
		messaging_product: "whatsapp",
		...(profile.about !== undefined && { about: profile.about }),
		...(profile.address !== undefined && { address: profile.address }),
		...(profile.description !== undefined && { description: profile.description }),
		...(profile.email !== undefined && { email: profile.email }),
		...(profile.profilePictureUrl !== undefined && { profile_picture_url: profile.profilePictureUrl }),
		...(profile.websites !== undefined && { websites: profile.websites }),
		...(profile.vertical !== undefined && { vertical: profile.vertical }),
	};
}
