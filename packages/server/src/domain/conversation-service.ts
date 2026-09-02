import type { Conversation } from "@whaloc/shared";
import type { MessageRecord, Repositories } from "../db/index.ts";
import { toConversationDto } from "./control-dto.ts";

/**
 * The conversation view (SPEC §5). whaloc stores no conversation rows: a conversation is
 * every message between one business phone number and one contact, so both the list and the
 * history are derived from the message table.
 */
export interface ConversationServiceOptions {
	repositories: Repositories;
}

export interface ListMessagesInput {
	phoneNumberId: string;
	contactWaId: string;
	limit: number;
	/** ISO timestamp to page backwards from, exclusive. */
	before?: string;
}

export interface ListMessagesResult {
	/** Oldest first, the order the UI renders them in. */
	messages: MessageRecord[];
	/** Cursor for the next (older) page, or `null` at the beginning of history. */
	before: string | null;
}

export class ConversationService {
	readonly #repositories: Repositories;

	constructor(options: ConversationServiceOptions) {
		this.#repositories = options.repositories;
	}

	/** Newest activity first, each with its contact and its most recent message. */
	async list(phoneNumberId?: string): Promise<Conversation[]> {
		const summaries = await this.#repositories.messages.listConversations(phoneNumberId);
		const conversations: Conversation[] = [];

		for (const summary of summaries) {
			const [lastMessage] = await this.#repositories.messages.listConversation({
				phoneNumberId: summary.phoneNumberId,
				contactWaId: summary.contactWaId,
				limit: 1,
			});

			conversations.push(
				toConversationDto({
					...summary,
					contact: await this.#repositories.contacts.findByWaId(summary.contactWaId),
					lastMessage: lastMessage ?? null,
				}),
			);
		}

		return conversations;
	}

	/**
	 * One page of history, newest last. A full page means there is probably more behind it, so
	 * the oldest timestamp on the page becomes the `before` cursor.
	 */
	async messages(input: ListMessagesInput): Promise<ListMessagesResult> {
		const messages = await this.#repositories.messages.listConversation({
			phoneNumberId: input.phoneNumberId,
			contactWaId: input.contactWaId,
			limit: input.limit,
			...(input.before !== undefined && { before: input.before }),
		});

		return {
			messages,
			before: messages.length < input.limit ? null : (messages[0]?.timestamp ?? null),
		};
	}
}
