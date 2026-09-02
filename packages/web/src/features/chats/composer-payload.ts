import {
	inboundRequestSchema,
	type InboundMediaType,
	type InboundRequest,
	type ReferralMediaType,
	type ReferralSourceType,
} from "@whaloc/shared";
import type { ZodError } from "zod";
import { asArray, asRecord } from "../../lib/json.ts";

/**
 * The composer's form state → the body of `POST /api/inbound` (SPEC §5).
 *
 * Every branch is built here and validated with the *same* schema the server validates it
 * with, so an invalid draft is caught while the user is still looking at the field that
 * caused it — and a request that leaves this function is one the control plane accepts by
 * construction. Keeping it a pure function is also what makes the payload shapes testable
 * without rendering the composer.
 */

export interface ComposerContext {
	phoneNumberId: string;
	/** The contact whose side of the conversation the UI is acting as. */
	from: string;
	/** wamid this message replies to; becomes the message's `context` node. */
	replyTo?: string | undefined;
	profileName?: string | undefined;
}

export type ComposerDraft =
	| { kind: "text"; body: string }
	| { kind: "media"; mediaType: InboundMediaType; mediaId: string; caption: string; filename: string }
	| { kind: "location"; latitude: string; longitude: string; name: string; address: string }
	| { kind: "reaction"; messageId: string; emoji: string }
	| { kind: "interactive"; replyType: "button_reply" | "list_reply"; id: string; title: string; description: string }
	| { kind: "button"; payload: string; text: string }
	| { kind: "contacts"; json: string }
	| { kind: "unsupported" };

/**
 * The context riders (SPEC §5), which are orthogonal to the message type: a forwarded location,
 * a reaction that came in from an ad, a text about a catalog product. They live beside the draft
 * rather than inside it so switching mode never loses them.
 */
export interface ComposerExtras {
	forwarded: boolean;
	frequentlyForwarded: boolean;
	referral: {
		enabled: boolean;
		sourceUrl: string;
		sourceType: ReferralSourceType;
		sourceId: string;
		headline: string;
		body: string;
		mediaType: "" | ReferralMediaType;
		imageUrl: string;
		videoUrl: string;
		thumbnailUrl: string;
		ctwaClid: string;
	};
	referredProduct: { enabled: boolean; catalogId: string; productRetailerId: string };
}

/** What the extras panel opens on: nothing set, both mini-forms off. */
export function emptyExtras(): ComposerExtras {
	return {
		forwarded: false,
		frequentlyForwarded: false,
		referral: {
			enabled: false,
			sourceUrl: "https://fb.me/whaloc-demo-ad",
			sourceType: "ad",
			sourceId: "1234567890",
			headline: "",
			body: "",
			mediaType: "",
			imageUrl: "",
			videoUrl: "",
			thumbnailUrl: "",
			ctwaClid: "",
		},
		referredProduct: { enabled: false, catalogId: "", productRetailerId: "" },
	};
}

/** Whether anything in the panel is actually set — what the composer's badge counts. */
export function hasExtras(extras: ComposerExtras): boolean {
	return extras.forwarded || extras.frequentlyForwarded || extras.referral.enabled || extras.referredProduct.enabled;
}

/** The rider keys of `POST /api/inbound`, built from the panel and dropped when empty. */
function riderFields(extras: ComposerExtras): Record<string, unknown> {
	return {
		...(extras.forwarded && { forwarded: true }),
		...(extras.frequentlyForwarded && { frequentlyForwarded: true }),
		...(extras.referredProduct.enabled && {
			referredProduct: {
				catalog_id: extras.referredProduct.catalogId.trim(),
				product_retailer_id: extras.referredProduct.productRetailerId.trim(),
			},
		}),
		...(extras.referral.enabled && {
			referral: {
				source_url: extras.referral.sourceUrl.trim(),
				source_type: extras.referral.sourceType,
				source_id: extras.referral.sourceId.trim(),
				...optional("headline", extras.referral.headline),
				...optional("body", extras.referral.body),
				...(extras.referral.mediaType !== "" && { media_type: extras.referral.mediaType }),
				...optional("image_url", extras.referral.imageUrl),
				...optional("video_url", extras.referral.videoUrl),
				...optional("thumbnail_url", extras.referral.thumbnailUrl),
				...optional("ctwa_clid", extras.referral.ctwaClid),
			},
		}),
	};
}

export type BuildResult = { ok: true; request: InboundRequest } | { ok: false; error: string };

function describeIssues(error: ZodError): string {
	return error.issues
		.map(issue => {
			const path = issue.path.map(String).join(".");

			return path === "" ? issue.message : `${path}: ${issue.message}`;
		})
		.join("; ");
}

/** Drops a field the user left blank instead of sending an empty string. */
function optional(key: string, value: string): Record<string, string> {
	const trimmed = value.trim();

	return trimmed === "" ? {} : { [key]: trimmed };
}

function validate(candidate: unknown): BuildResult {
	const parsed = inboundRequestSchema.safeParse(candidate);

	return parsed.success ? { ok: true, request: parsed.data } : { ok: false, error: describeIssues(parsed.error) };
}

export function buildInboundRequest(
	context: ComposerContext,
	draft: ComposerDraft,
	extras: ComposerExtras = emptyExtras(),
): BuildResult {
	// A reaction names its target itself, so it is the one branch built without the reply
	// context: `identity` is the pair every inbound message carries, `base` adds the quote.
	// The riders ride on both, because they apply to every inbound type (SPEC §5).
	const identity = {
		phoneNumberId: context.phoneNumberId,
		from: context.from,
		...(context.profileName !== undefined && optional("profileName", context.profileName)),
		...riderFields(extras),
	};
	const base = {
		...identity,
		...(context.replyTo !== undefined && optional("replyTo", context.replyTo)),
	};

	switch (draft.kind) {
		case "text": {
			return validate({ ...base, type: "text", text: { body: draft.body.trim() } });
		}

		case "media": {
			return validate({
				...base,
				type: draft.mediaType,
				media: {
					id: draft.mediaId,
					...optional("caption", draft.caption),
					...optional("filename", draft.filename),
				},
			});
		}

		case "location": {
			const latitude = Number(draft.latitude);
			const longitude = Number(draft.longitude);

			if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
				return { ok: false, error: "latitude and longitude must be numbers" };
			}

			return validate({
				...base,
				type: "location",
				location: {
					latitude,
					longitude,
					...optional("name", draft.name),
					...optional("address", draft.address),
				},
			});
		}

		case "reaction": {
			return validate({
				...identity,
				type: "reaction",
				reaction: { message_id: draft.messageId, emoji: draft.emoji },
			});
		}

		case "interactive": {
			const reply = {
				id: draft.id.trim(),
				title: draft.title.trim(),
				...(draft.replyType === "list_reply" && optional("description", draft.description)),
			};

			return validate({
				...base,
				type: "interactive",
				interactive: { type: draft.replyType, [draft.replyType]: reply },
			});
		}

		case "button": {
			return validate({
				...base,
				type: "button",
				button: { payload: draft.payload.trim(), text: draft.text.trim() },
			});
		}

		case "contacts": {
			let parsed: unknown;

			try {
				parsed = JSON.parse(draft.json);
			} catch (error) {
				return { ok: false, error: `contacts must be valid JSON: ${Error.isError(error) ? error.message : ""}` };
			}

			// Meta's node is an array; a single card pasted from a webhook is wrapped rather
			// than rejected, because that is the shape people copy.
			const contacts = asRecord(parsed) === null ? asArray(parsed) : [parsed];

			return validate({ ...base, type: "contacts", contacts });
		}

		case "unsupported": {
			// Nothing to fill in: the server builds Meta's 131051 error node (SPEC §5).
			return validate({ ...base, type: "unsupported" });
		}
	}
}

/** The empty draft each composer mode starts from. */
export function emptyDraft(kind: ComposerDraft["kind"], mediaType: InboundMediaType = "image"): ComposerDraft {
	switch (kind) {
		case "text": {
			return { kind: "text", body: "" };
		}

		case "media": {
			return { kind: "media", mediaType, mediaId: "", caption: "", filename: "" };
		}

		case "location": {
			return { kind: "location", latitude: "", longitude: "", name: "", address: "" };
		}

		case "reaction": {
			return { kind: "reaction", messageId: "", emoji: "👍" };
		}

		case "interactive": {
			return { kind: "interactive", replyType: "button_reply", id: "", title: "", description: "" };
		}

		case "button": {
			return { kind: "button", payload: "", text: "" };
		}

		case "contacts": {
			return { kind: "contacts", json: CONTACTS_EXAMPLE };
		}

		case "unsupported": {
			return { kind: "unsupported" };
		}
	}
}

/** A contact card in Meta's shape, so the JSON editor opens on something valid. */
export const CONTACTS_EXAMPLE = JSON.stringify(
	[
		{
			name: { formatted_name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace" },
			phones: [{ phone: "+55 11 91234-5678", type: "CELL", wa_id: "5511912345678" }],
		},
	],
	null,
	2,
);
