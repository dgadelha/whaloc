import type { RejectTemplateRequest } from "@whaloc/shared";
import type { QualityRating } from "../config/index.ts";
import type { Repositories, TemplateRecord, TemplateStatus } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import type { BackgroundTasks } from "./background-tasks.ts";
import { toTemplateDto } from "./control-dto.ts";
import type { TemplateLifecycleEvents } from "./domain-events.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createSystemScheduler, type ScheduledTask, type Scheduler } from "./scheduler.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";
import {
	templateQualityValue,
	templateStatusValue,
	webhookEnvelope,
	WEBHOOK_FIELDS,
	type TemplateDisableInfo,
	type TemplateOtherInfo,
	type TemplateRejectionInfo,
} from "./webhook-payloads.ts";

/**
 * Template review, the way Meta's looks from the outside (SPEC §4).
 *
 * A created or edited template is `PENDING`; `WHALOC_TEMPLATE_AUTO_APPROVE` decides whether it
 * approves itself after a delay or waits for a human to press approve or reject in the UI.
 * Every transition persists and emits `message_template_status_update` — including `DELETED`,
 * which Meta does send when a template is removed.
 *
 * Two deliberate choices about which transitions announce themselves:
 *
 * - **Creation does not.** The `POST /{wabaId}/message_templates` response already says
 *   `PENDING`; a webhook that arrives before the caller has stored the id is noise.
 * - **An edit does.** It moves a template that may have been `APPROVED` back to `PENDING`,
 *   which is a state change the app under test cannot see any other way.
 */

export interface TemplateLifecycleOptions {
	repositories: Repositories;
	webhooks: WebhookEmitter;
	tasks: BackgroundTasks;
	logger: Logger;
	/** `WHALOC_TEMPLATE_AUTO_APPROVE`; `null` keeps review manual (SPEC §7). */
	autoApproveMs: number | null;
	events?: EventPublisher;
	scheduler?: Scheduler;
}

/** The `event` values whaloc emits, all of them Meta's own. */
export const TEMPLATE_EVENTS = {
	approved: "APPROVED",
	rejected: "REJECTED",
	pending: "PENDING",
	paused: "PAUSED",
	disabled: "DISABLED",
	deleted: "DELETED",
} as const;

/**
 * Meta's `other_info` for the two transitions that lock a template. The titles come from its own
 * enum (`FIRST_PAUSE`, `SECOND_PAUSE`, `RATE_LIMITING_PAUSE`, `UNPAUSE`, `DISABLED`) and the
 * descriptions are the sentences it shows the business.
 */
const FIRST_PAUSE_INFO: TemplateOtherInfo = {
	title: "FIRST_PAUSE",
	description: "Your WhatsApp message template has been paused due to negative customer feedback.",
};

const DISABLED_INFO: TemplateOtherInfo = {
	title: "DISABLED",
	description: "Your WhatsApp message template has been disabled due to negative customer feedback.",
};

/** What Meta writes in `rejection_info` for a formatting rejection; whaloc's default. */
const DEFAULT_REJECTION_INFO: TemplateRejectionInfo = {
	reason:
		"Your template has parameters placed next to each other (like {{1}}{{2}}) without text or punctuation between them.",
	recommendation: "Separate parameters with descriptive text and ensure each parameter is clearly contextualized.",
};

export class TemplateLifecycle implements TemplateLifecycleEvents {
	readonly #repositories: Repositories;
	readonly #webhooks: WebhookEmitter;
	readonly #tasks: BackgroundTasks;
	readonly #logger: Logger;
	readonly #autoApproveMs: number | null;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #pending = new Map<string, ScheduledTask>();

	constructor(options: TemplateLifecycleOptions) {
		this.#repositories = options.repositories;
		this.#webhooks = options.webhooks;
		this.#tasks = options.tasks;
		this.#logger = options.logger;
		this.#autoApproveMs = options.autoApproveMs;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	#scheduleApproval(templateId: string): void {
		if (this.#autoApproveMs === null) {
			return;
		}

		this.cancel(templateId);

		const task = this.#scheduler.schedule(this.#autoApproveMs, () => {
			this.#pending.delete(templateId);
			this.#tasks.run(() => this.#autoApprove(templateId));
		});

		this.#pending.set(templateId, task);
	}

	/** The timer only ever approves a template that is still `PENDING`. */
	async #autoApprove(templateId: string): Promise<void> {
		const template = await this.#repositories.templates.findById(templateId);

		if (template === null || template.status !== "PENDING") {
			return;
		}

		this.#logger.debug({ templateId, name: template.name }, "auto-approving template");

		await this.approve(templateId);
	}

	async #moderate(
		templateId: string,
		status: TemplateStatus,
		event: string,
		options: {
			rejectedReason?: string | null;
			reason?: string | null;
			rejectionInfo?: TemplateRejectionInfo;
			otherInfo?: TemplateOtherInfo;
			disableInfo?: TemplateDisableInfo;
		},
	): Promise<TemplateRecord | null> {
		if ((await this.#repositories.templates.findById(templateId)) === null) {
			return null;
		}

		// A moderation decision settles the review: whatever the timer had queued is moot.
		this.cancel(templateId);

		const updated = await this.#repositories.templates.update(templateId, {
			status,
			...(options.rejectedReason !== undefined && { rejectedReason: options.rejectedReason }),
			updatedAt: this.#scheduler.now().toISOString(),
		});

		if (updated === null) {
			return null;
		}

		this.#tasks.run(() => {
			return this.#announce(updated, event, {
				...(options.reason !== undefined && { reason: options.reason }),
				...(options.rejectionInfo !== undefined && { rejectionInfo: options.rejectionInfo }),
				...(options.otherInfo !== undefined && { otherInfo: options.otherInfo }),
				...(options.disableInfo !== undefined && { disableInfo: options.disableInfo }),
			});
		});

		return updated;
	}

	/** WebSocket first, webhook right after — the same order the status ladder uses. */
	async #announce(
		template: TemplateRecord,
		event: string,
		options: {
			reason?: string | null;
			rejectionInfo?: TemplateRejectionInfo;
			otherInfo?: TemplateOtherInfo;
			disableInfo?: TemplateDisableInfo;
		} = {},
	): Promise<void> {
		this.#events.publish({ type: "template.changed", payload: { template: toTemplateDto(template), event } });

		const value = templateStatusValue({
			template,
			event,
			...(options.reason !== undefined && { reason: options.reason }),
			...(options.rejectionInfo !== undefined && { rejectionInfo: options.rejectionInfo }),
			...(options.otherInfo !== undefined && { otherInfo: options.otherInfo }),
			...(options.disableInfo !== undefined && { disableInfo: options.disableInfo }),
		});

		await this.#webhooks.emit(
			WEBHOOK_FIELDS.templateStatus,
			webhookEnvelope({
				wabaId: template.wabaId,
				field: WEBHOOK_FIELDS.templateStatus,
				value,
				time: this.#scheduler.now(),
			}),
		);
	}

	onTemplateCreated(template: TemplateRecord): void {
		this.#scheduleApproval(template.id);
	}

	onTemplateEdited(template: TemplateRecord): void {
		this.#tasks.run(() => this.#announce(template, TEMPLATE_EVENTS.pending));
		this.#scheduleApproval(template.id);
	}

	onTemplateDeleted(templates: readonly TemplateRecord[]): void {
		for (const template of templates) {
			this.cancel(template.id);
			// A template scheduled for deletion reports `reason: null`, not the `"NONE"` string
			// every other transition sends — Meta is explicit about the type change.
			this.#tasks.run(() => this.#announce(template, TEMPLATE_EVENTS.deleted, { reason: null }));
		}
	}

	cancel(templateId: string): void {
		this.#pending.get(templateId)?.cancel();
		this.#pending.delete(templateId);
	}

	cancelAll(): void {
		for (const task of this.#pending.values()) {
			task.cancel();
		}

		this.#pending.clear();
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	/** Approves a template — from the timer, or from `POST /api/templates/:id/approve`. */
	async approve(templateId: string): Promise<TemplateRecord | null> {
		return this.#moderate(templateId, "APPROVED", TEMPLATE_EVENTS.approved, { rejectedReason: null });
	}

	/**
	 * Rejects a template with Meta's `reason` and the free-text `rejection_info` a reviewer
	 * would have written (SPEC §4).
	 */
	async reject(templateId: string, request: RejectTemplateRequest): Promise<TemplateRecord | null> {
		return this.#moderate(templateId, "REJECTED", TEMPLATE_EVENTS.rejected, {
			rejectedReason: request.reason,
			reason: request.reason,
			rejectionInfo: request.rejectionInfo ?? DEFAULT_REJECTION_INFO,
		});
	}

	/**
	 * Meta pauses templates whose quality drops; the UI triggers it here.
	 *
	 * A pause is one of Meta's "locked" transitions, so it carries `other_info` naming *which*
	 * pause it is — whaloc reports the first one, since it has no pause history to count.
	 */
	async pause(templateId: string): Promise<TemplateRecord | null> {
		return this.#moderate(templateId, "PAUSED", TEMPLATE_EVENTS.paused, { otherInfo: FIRST_PAUSE_INFO });
	}

	/** Disabling carries both `other_info` and the `disable_info` timestamp Meta stamps on it. */
	async disable(templateId: string): Promise<TemplateRecord | null> {
		return this.#moderate(templateId, "DISABLED", TEMPLATE_EVENTS.disabled, {
			otherInfo: DISABLED_INFO,
			disableInfo: { disabledAt: this.#scheduler.now() },
		});
	}

	/**
	 * `POST /api/templates/:id/quality` — stores the new score and emits
	 * `message_template_quality_update` with the one it replaced (SPEC §5).
	 */
	async setQualityScore(templateId: string, qualityScore: QualityRating): Promise<TemplateRecord | null> {
		const template = await this.#repositories.templates.findById(templateId);

		if (template === null) {
			return null;
		}

		const updated = await this.#repositories.templates.update(templateId, {
			qualityScore: qualityScore,
			updatedAt: this.#scheduler.now().toISOString(),
		});

		if (updated === null) {
			return null;
		}

		this.#events.publish({
			type: "template.changed",
			payload: { template: toTemplateDto(updated), event: "QUALITY" },
		});

		this.#tasks.run(async () => {
			const value = templateQualityValue({
				template: updated,
				previousQualityScore: template.qualityScore,
				qualityScore,
			});

			await this.#webhooks.emit(
				WEBHOOK_FIELDS.templateQuality,
				webhookEnvelope({
					wabaId: updated.wabaId,
					field: WEBHOOK_FIELDS.templateQuality,
					value,
					time: this.#scheduler.now(),
				}),
			);
		});

		return updated;
	}
}
