import { MESSAGE_ERROR_CODES, type MessageErrorCode } from "@whaloc/shared";
import type { JsonObject } from "../db/index.ts";

/**
 * The failures a `failed` status can carry (SPEC §4). Nothing fails on its own in whaloc —
 * a user picks one of these from the UI or the control plane, and the webhook goes out with
 * Meta's `errors[]` node shaped exactly like the `status-failed` fixture.
 *
 * Titles and details are Meta's own wording for these codes; the `href` is the one Meta puts
 * on every messaging error.
 */

/** Same documentation link Meta attaches to messaging errors. */
export const ERROR_DOCS_HREF = "/documentation/business-messaging/whatsapp/support/error-codes";

export interface MessageErrorPreset {
	code: MessageErrorCode;
	title: string;
	message: string;
	details: string;
}

export const MESSAGE_ERROR_PRESETS: Record<MessageErrorCode, MessageErrorPreset> = {
	131_049: {
		code: 131_049,
		title: "This message was not delivered to maintain healthy ecosystem engagement.",
		message: "This message was not delivered to maintain healthy ecosystem engagement.",
		details: "In order to maintain a healthy ecosystem engagement, the message failed to be delivered.",
	},
	131_026: {
		code: 131_026,
		title: "Message undeliverable",
		message: "Message undeliverable",
		details:
			"Unable to deliver message. Reasons can include: the recipient phone number is not a WhatsApp phone number, the recipient has not accepted our new Terms of Service and Privacy Policy, or the recipient is using an old WhatsApp version.",
	},
	131_047: {
		code: 131_047,
		title: "Re-engagement message",
		message: "Re-engagement message",
		details: "More than 24 hours have passed since the recipient last replied to the sender number.",
	},
	130_472: {
		code: 130_472,
		title: "User's number is part of an experiment",
		message: "User's number is part of an experiment",
		details:
			"Message failed to send because this user's phone number is part of an experiment. Learn more in the documentation.",
	},
};

/** The preset a manual `failed` transition uses when the caller does not pick one. */
export const DEFAULT_MESSAGE_ERROR_CODE: MessageErrorCode = 131_049;

export function messageErrorPreset(code: MessageErrorCode = DEFAULT_MESSAGE_ERROR_CODE): MessageErrorPreset {
	return MESSAGE_ERROR_PRESETS[code];
}

/** The `errors[]` node of a `failed` status, and what is stored in `messages.error`. */
export function messageErrorNode(preset: MessageErrorPreset): JsonObject {
	return {
		code: preset.code,
		title: preset.title,
		message: preset.message,
		error_data: { details: preset.details },
		href: ERROR_DOCS_HREF,
	};
}

/** Every preset, for the UI's error picker. */
export function listMessageErrorPresets(): MessageErrorPreset[] {
	return MESSAGE_ERROR_CODES.map(code => MESSAGE_ERROR_PRESETS[code]);
}
