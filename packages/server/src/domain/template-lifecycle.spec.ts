import type { WsEvent } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateRecord } from "../db/index.ts";
import { createDomainHarness, type DomainHarness } from "../testing/domain-harness.ts";
import { anyString, stringContaining, stringMatching } from "../testing/expectations.ts";
import { TemplateLifecycle } from "./template-lifecycle.ts";
import { TemplateService } from "./template-service.ts";
import { WebhookEmitter } from "./webhook-emitter.ts";

/**
 * Template review (SPEC §4), on fake timers and against the real emitter with no webhook URL
 * — so the delivery log records the payload that would have gone out.
 */
describe("TemplateLifecycle", () => {
	let harness: DomainHarness;
	let events: WsEvent[];

	beforeEach(async () => {
		vi.useFakeTimers();
		harness = await createDomainHarness();
		events = [];
	});

	afterEach(async () => {
		vi.useRealTimers();
		await harness.close();
	});

	function createLifecycle(autoApproveMs: number | null): TemplateLifecycle {
		const publish = (event: WsEvent): void => {
			events.push(event);
		};

		return new TemplateLifecycle({
			repositories: harness.repositories,
			webhooks: new WebhookEmitter({
				repositories: harness.repositories,
				logger: harness.logger,
				target: {},
				events: { publish },
			}),
			tasks: harness.tasks,
			logger: harness.logger,
			autoApproveMs,
			events: { publish },
		});
	}

	async function insertTemplate(overrides: { name?: string; language?: string } = {}): Promise<TemplateRecord> {
		return harness.repositories.templates.insert({
			id: `10000000000000${String(events.length)}`.slice(0, 15),
			wabaId: harness.wabaId,
			name: overrides.name ?? "order_update",
			language: overrides.language ?? "en_US",
			category: "UTILITY",
			components: [{ type: "BODY", text: "Hi {{1}}" }],
			status: "PENDING",
		});
	}

	async function tick(ms: number): Promise<void> {
		await vi.advanceTimersByTimeAsync(ms);
		await harness.tasks.whenIdle();
	}

	async function statusOf(templateId: string): Promise<string | undefined> {
		const template = await harness.repositories.templates.findById(templateId);

		return template?.status;
	}

	/** The `event` of every template webhook logged so far, oldest first. */
	async function emittedEvents(): Promise<unknown[]> {
		const values = await emitted();

		return values.map(value => value["event"]);
	}

	/** Every template webhook logged so far, oldest first. */
	async function emitted(): Promise<Record<string, unknown>[]> {
		const deliveries = await harness.repositories.webhookDeliveries.list({ limit: 100 });

		return deliveries.toReversed().map(delivery => {
			const body = JSON.parse(delivery.requestBody) as { entry: [{ changes: [{ value: Record<string, unknown> }] }] };

			return body.entry[0].changes[0].value;
		});
	}

	describe("auto-approval", () => {
		it("approves a created template after the configured delay", async () => {
			const lifecycle = createLifecycle(2000);
			const template = await insertTemplate();

			lifecycle.onTemplateCreated(template);
			expect(lifecycle.pendingCount).toBe(1);

			await tick(1999);
			expect(await statusOf(template.id)).toBe("PENDING");
			expect(await emitted()).toEqual([]);

			await tick(1);
			expect(await statusOf(template.id)).toBe("APPROVED");
			expect(await emitted()).toEqual([
				expect.objectContaining({
					event: "APPROVED",
					message_template_id: Number(template.id),
					message_template_name: template.name,
					message_template_language: template.language,
					reason: "NONE",
					message_template_category: "UTILITY",
				}),
			]);
			expect(lifecycle.pendingCount).toBe(0);
		});

		it("stays out of the way when auto-approval is off", async () => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();

			lifecycle.onTemplateCreated(template);
			await tick(60_000);

			expect(lifecycle.pendingCount).toBe(0);
			expect(await statusOf(template.id)).toBe("PENDING");
			expect(await emitted()).toEqual([]);
		});

		it("does not approve a template a reviewer already decided on", async () => {
			const lifecycle = createLifecycle(2000);
			const template = await insertTemplate();

			lifecycle.onTemplateCreated(template);
			await harness.repositories.templates.update(template.id, { status: "REJECTED" });
			await tick(2000);

			expect(await statusOf(template.id)).toBe("REJECTED");
		});

		it("announces PENDING on an edit, then approves again", async () => {
			const lifecycle = createLifecycle(2000);
			const template = await insertTemplate();

			lifecycle.onTemplateEdited(template);
			await harness.tasks.whenIdle();

			expect(await emitted()).toEqual([expect.objectContaining({ event: "PENDING" })]);

			await tick(2000);

			expect(await emittedEvents()).toEqual(["PENDING", "APPROVED"]);
		});
	});

	describe("moderation", () => {
		it("approves on demand", async () => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();
			const approved = await lifecycle.approve(template.id);

			await harness.tasks.whenIdle();

			expect(approved?.status).toBe("APPROVED");
			expect(await emitted()).toEqual([expect.objectContaining({ event: "APPROVED", reason: "NONE" })]);
			expect(events.some(event => event.type === "template.changed")).toBe(true);
		});

		it("rejects with a reason and the rejection_info a reviewer would have written", async () => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();
			const rejected = await lifecycle.reject(template.id, {
				reason: "INVALID_FORMAT",
				rejectionInfo: { reason: "Parameters are adjacent.", recommendation: "Separate them." },
			});

			await harness.tasks.whenIdle();

			expect(rejected).toMatchObject({ status: "REJECTED", rejectedReason: "INVALID_FORMAT" });
			expect(await emitted()).toEqual([
				expect.objectContaining({
					event: "REJECTED",
					reason: "INVALID_FORMAT",
					rejection_info: { reason: "Parameters are adjacent.", recommendation: "Separate them." },
				}),
			]);
		});

		it("falls back to Meta's own rejection wording", async () => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();

			await lifecycle.reject(template.id, { reason: "INVALID_FORMAT" });
			await harness.tasks.whenIdle();

			const [value] = await emitted();

			expect(value!["rejection_info"]).toMatchObject({
				reason: stringContaining("{{1}}{{2}}"),
				recommendation: anyString(),
			});
		});

		it("cancels the pending auto-approval", async () => {
			const lifecycle = createLifecycle(2000);
			const template = await insertTemplate();

			lifecycle.onTemplateCreated(template);
			await lifecycle.reject(template.id, { reason: "SCAM" });
			await tick(60_000);

			expect(await statusOf(template.id)).toBe("REJECTED");
			expect(await emittedEvents()).toEqual(["REJECTED"]);
		});

		it.each([
			["pause", "PAUSED"],
			["disable", "DISABLED"],
		] as const)("%ss a template", async (action, status) => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();

			await lifecycle[action](template.id);
			await harness.tasks.whenIdle();

			expect(await statusOf(template.id)).toBe(status);
			expect(await emitted()).toEqual([expect.objectContaining({ event: status })]);
		});

		/**
		 * Meta attaches `other_info` to the transitions that *lock* a template, and stamps a
		 * `disable_info.disable_date` on the disable specifically — that pair is how a consumer
		 * tells a first pause from a disable and shows the business why.
		 */
		it("names which pause it is, the way Meta's other_info does", async () => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();

			await lifecycle.pause(template.id);
			await harness.tasks.whenIdle();

			const [value] = await emitted();

			expect(value).toMatchObject({
				event: "PAUSED",
				other_info: { title: "FIRST_PAUSE", description: stringContaining("paused") },
			});
			expect(value).not.toHaveProperty("disable_info");
		});

		it("stamps disable_info on a disable, as a string of unix seconds", async () => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();

			await lifecycle.disable(template.id);
			await harness.tasks.whenIdle();

			const [value] = await emitted();

			expect(value).toMatchObject({
				event: "DISABLED",
				other_info: { title: "DISABLED", description: stringContaining("disabled") },
				disable_info: { disable_date: stringMatching(/^\d{10}$/) },
			});
		});

		it("reports an unknown template", async () => {
			const lifecycle = createLifecycle(null);

			expect(await lifecycle.approve("404")).toBeNull();
			expect(await lifecycle.reject("404", { reason: "SCAM" })).toBeNull();
			expect(await lifecycle.pause("404")).toBeNull();
			expect(await lifecycle.setQualityScore("404", "RED")).toBeNull();
		});
	});

	describe("quality", () => {
		it("stores the score and emits the quality update with the one it replaced", async () => {
			const lifecycle = createLifecycle(null);
			const template = await insertTemplate();

			await lifecycle.setQualityScore(template.id, "GREEN");
			await harness.tasks.whenIdle();
			const updated = await lifecycle.setQualityScore(template.id, "YELLOW");

			await harness.tasks.whenIdle();

			expect(updated?.qualityScore).toBe("YELLOW");
			expect(await emitted()).toEqual([
				expect.objectContaining({ previous_quality_score: "UNKNOWN", new_quality_score: "GREEN" }),
				expect.objectContaining({
					previous_quality_score: "GREEN",
					new_quality_score: "YELLOW",
					message_template_id: Number(template.id),
					message_template_name: template.name,
				}),
			]);
		});
	});

	describe("deletion", () => {
		it("emits DELETED for every language that was removed, the way Meta does", async () => {
			const lifecycle = createLifecycle(2000);
			const templates = new TemplateService({
				repositories: harness.repositories,
				events: lifecycle,
				uploads: harness.uploads,
			});

			await templates.create(harness.wabaId, {
				name: "order_update",
				language: "en_US",
				category: "UTILITY",
				components: [{ type: "BODY", text: "Hi" }],
				parameter_format: "POSITIONAL",
			});
			await templates.create(harness.wabaId, {
				name: "order_update",
				language: "pt_BR",
				category: "UTILITY",
				components: [{ type: "BODY", text: "Oi" }],
				parameter_format: "POSITIONAL",
			});

			expect(lifecycle.pendingCount).toBe(2);

			await templates.delete({ wabaId: harness.wabaId, name: "order_update" });
			await harness.tasks.whenIdle();

			expect(lifecycle.pendingCount).toBe(0);
			expect(await emitted()).toEqual([
				expect.objectContaining({ event: "DELETED", message_template_language: "en_US" }),
				expect.objectContaining({ event: "DELETED", message_template_language: "pt_BR" }),
			]);
			// A template scheduled for deletion reports `reason: null`, not the `"NONE"` string
			// every other transition sends — the one place Meta changes that field's type.
			const deletions = await emitted();

			for (const value of deletions) {
				expect(value["reason"]).toBeNull();
			}

			// The approval timers were cancelled with the templates they belonged to.
			await tick(60_000);
			expect(await emittedEvents()).toEqual(["DELETED", "DELETED"]);
		});
	});

	describe("cancelAll", () => {
		it("drops every pending review, which is what a reset needs", async () => {
			const lifecycle = createLifecycle(2000);
			const template = await insertTemplate();

			lifecycle.onTemplateCreated(template);
			lifecycle.cancelAll();
			await tick(60_000);

			expect(lifecycle.pendingCount).toBe(0);
			expect(await statusOf(template.id)).toBe("PENDING");
		});
	});
});
