import type { ListAllTemplatesQuery, Repositories, TemplateFilters, TemplateRecord } from "../db/index.ts";
import type { TemplateLifecycleEvents } from "./domain-events.ts";
import { createTemplateId, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { templateAlreadyExistsError, templateNotDeletedError, unknownObjectError } from "./meta-errors.ts";
import { assertHeaderHandlesResolve } from "./template-header-handles.ts";
import type { TemplateCreateRequest, TemplateEditRequest } from "./template-requests.ts";
import type { UploadService } from "./upload-service.ts";

export interface TemplateServiceOptions {
	repositories: Repositories;
	events: TemplateLifecycleEvents;
	/** Resolves `components[].example.header_handle[]` against the Upload API (SPEC §2.21). */
	uploads: UploadService;
	random?: RandomBytes;
}

export interface ListTemplatesInput extends TemplateFilters {
	wabaId: string;
	limit: number;
	/** Template id to page after, already decoded from the opaque `after` cursor. */
	afterId?: string;
	/** Template id to page before, decoded from the opaque `before` cursor (SPEC §1.5). */
	beforeId?: string;
}

export interface ListTemplatesResult {
	templates: TemplateRecord[];
	/**
	 * Whether a further page exists — the one thing `paging.next` must be right about, since
	 * the consumer stops paging the moment it is absent (SPEC §1.5).
	 */
	hasNextPage: boolean;
	/** The same question the other way, which is what makes `paging.previous` honest. */
	hasPreviousPage: boolean;
}

export interface DeleteTemplatesInput {
	wabaId: string;
	name: string;
	/** `hsm_id`: narrows the delete to one language instead of all of them (SPEC §2.10). */
	hsmId?: string;
}

/**
 * Template management (SPEC §2.7–§2.10). Every mutation ends in a {@link TemplateLifecycleEvents}
 * call, which is where auto-approval and the `message_template_status_update` webhooks hang
 * (SPEC §4).
 */
export class TemplateService {
	readonly #repositories: Repositories;
	readonly #events: TemplateLifecycleEvents;
	readonly #uploads: UploadService;
	readonly #random: RandomBytes;

	constructor(options: TemplateServiceOptions) {
		this.#repositories = options.repositories;
		this.#events = options.events;
		this.#uploads = options.uploads;
		this.#random = options.random ?? defaultRandomBytes;
	}

	async #assertWabaExists(wabaId: string): Promise<void> {
		if ((await this.#repositories.wabas.findById(wabaId)) === null) {
			throw unknownObjectError(wabaId);
		}
	}

	async create(wabaId: string, request: TemplateCreateRequest): Promise<TemplateRecord> {
		await this.#assertWabaExists(wabaId);

		const existing = await this.#repositories.templates.findByNameAndLanguage(wabaId, request.name, request.language);

		if (existing !== null) {
			throw templateAlreadyExistsError(request.name, request.language);
		}

		await assertHeaderHandlesResolve(this.#uploads, request.components);

		const template = await this.#repositories.templates.insert({
			id: createTemplateId(this.#random),
			wabaId,
			name: request.name,
			language: request.language,
			category: request.category,
			parameterFormat: request.parameter_format,
			components: request.components,
			status: "PENDING",
		});

		this.#events.onTemplateCreated(template);

		return template;
	}

	/**
	 * One page, plus the answers to "is there another one?" in both directions (SPEC §1.5).
	 *
	 * The neighbours are asked for as one-row pages of the *same* filtered query rather than
	 * inferred from an extra row, which keeps `next` and `previous` correct under every filter
	 * and in both paging directions — the property the consumer's paging loop depends on.
	 */
	async list(input: ListTemplatesInput): Promise<ListTemplatesResult> {
		await this.#assertWabaExists(input.wabaId);

		const filters: TemplateFilters = {
			...(input.name !== undefined && { name: input.name }),
			...(input.nameOrContent !== undefined && { nameOrContent: input.nameOrContent }),
			...(input.status !== undefined && { status: input.status }),
			...(input.category !== undefined && { category: input.category }),
			...(input.language !== undefined && { language: input.language }),
		};
		const templates = await this.#repositories.templates.list({
			wabaId: input.wabaId,
			limit: input.limit,
			...(input.afterId !== undefined && { afterId: input.afterId }),
			...(input.beforeId !== undefined && { beforeId: input.beforeId }),
			...filters,
		});
		const first = templates[0];
		const last = templates.at(-1);

		if (first === undefined || last === undefined) {
			// An empty page has no neighbours to report, whatever the cursors said.
			return { templates, hasNextPage: false, hasPreviousPage: false };
		}

		const [after, before] = await Promise.all([
			this.#repositories.templates.list({ wabaId: input.wabaId, limit: 1, afterId: last.id, ...filters }),
			this.#repositories.templates.list({ wabaId: input.wabaId, limit: 1, beforeId: first.id, ...filters }),
		]);

		return { templates, hasNextPage: after.length > 0, hasPreviousPage: before.length > 0 };
	}

	/** Every template, for the control plane's moderation view (SPEC §5) — no cursors here. */
	async listAll(query: ListAllTemplatesQuery = {}): Promise<TemplateRecord[]> {
		return this.#repositories.templates.listAll(query);
	}

	/** An edit sends the template back to `PENDING` and clears any rejection (SPEC §2.9). */
	async edit(templateId: string, request: TemplateEditRequest): Promise<TemplateRecord> {
		if ((await this.#repositories.templates.findById(templateId)) === null) {
			throw unknownObjectError(templateId);
		}

		await assertHeaderHandlesResolve(this.#uploads, request.components);

		const template = await this.#repositories.templates.update(templateId, {
			components: request.components,
			category: request.category,
			status: "PENDING",
			rejectedReason: null,
		});

		if (template === null) {
			throw unknownObjectError(templateId);
		}

		this.#events.onTemplateEdited(template);

		return template;
	}

	/** Deletes every language of a name, or just the one `hsm_id` names (SPEC §2.10). */
	async delete(input: DeleteTemplatesInput): Promise<TemplateRecord[]> {
		await this.#assertWabaExists(input.wabaId);

		const named = await this.#repositories.templates.findByName(input.wabaId, input.name);
		const doomed = input.hsmId === undefined ? named : named.filter(template => template.id === input.hsmId);

		if (doomed.length === 0) {
			throw templateNotDeletedError(input.name);
		}

		for (const template of doomed) {
			await this.#repositories.templates.deleteById(template.id);
		}

		this.#events.onTemplateDeleted(doomed);

		return doomed;
	}
}
