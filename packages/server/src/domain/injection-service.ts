import type { InjectionRuleCreateRequest, InjectionTarget, InjectionTrigger } from "@whaloc/shared";
import type { InjectionRuleRecord, Repositories } from "../db/index.ts";
import { toInjectionRuleDto } from "./control-dto.ts";
import { controlNotFound } from "./control-plane-error.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import type { GraphApiError } from "./graph-api-error.ts";
import { createInjectionRuleId, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { injectionResponse } from "./injection-presets.ts";

/**
 * Deterministic error injection (SPEC §4).
 *
 * The whole decision lives here, Hono-free: the Graph surface classifies a request into an
 * endpoint class, asks {@link InjectionService.evaluate} what should happen to it, and either
 * gets `null` (carry on) or a {@link GraphApiError} to throw. Nothing is probabilistic — the
 * golden rule — and every rule counts *its own* matching requests, so an `every 3rd` cadence is
 * a property of the rule rather than of whatever else the server was doing.
 *
 * **Several rules on one request**: every rule whose target matches sees the request and has its
 * `seen` counter advanced; the **first one in creation order that its trigger arms** is the one
 * that answers. A rule shadowed by an earlier one keeps its countdown intact — it has not fired
 * yet, and a countdown that ran out without ever producing a 429 would be a lie.
 */
export interface InjectionServiceOptions {
	repositories: Repositories;
	events?: EventPublisher;
	random?: RandomBytes;
}

export interface InjectionDecision {
	/** The rule that fired, already updated; the caller logs it. */
	rule: InjectionRuleRecord;
	/** The failure to throw — envelope, status and any throttling headers (SPEC §1.11). */
	error: GraphApiError;
}

/** Whether a rule's trigger arms it for the request it has just seen. */
function isArmed(trigger: InjectionTrigger, rule: { seen: number; remaining: number | null }): boolean {
	switch (trigger.kind) {
		case "always": {
			return true;
		}

		case "next": {
			return (rule.remaining ?? 0) > 0;
		}

		case "every": {
			// `seen` already counts this request, so `nth: 3` fires on the 3rd, 6th, 9th…
			return rule.seen % trigger.nth === 0;
		}
	}
}

export class InjectionService {
	readonly #repositories: Repositories;
	readonly #events: EventPublisher;
	readonly #random: RandomBytes;

	constructor(options: InjectionServiceOptions) {
		this.#repositories = options.repositories;
		this.#events = options.events ?? noopEventPublisher;
		this.#random = options.random ?? defaultRandomBytes;
	}

	#announce(rule: InjectionRuleRecord, event: "created" | "updated" | "deleted"): void {
		this.#events.publish({ type: "injection.changed", payload: { rule: toInjectionRuleDto(rule), event } });
	}

	/** Keys `X-Business-Use-Case-Usage`; whaloc reports the first WABA it knows about. */
	async #usageWabaId(): Promise<string | undefined> {
		const wabas = await this.#repositories.wabas.list();

		return wabas[0]?.id;
	}

	async list(): Promise<InjectionRuleRecord[]> {
		return this.#repositories.injectionRules.list();
	}

	async create(request: InjectionRuleCreateRequest): Promise<InjectionRuleRecord> {
		const rule = await this.#repositories.injectionRules.insert({
			// Time-ordered, because "the first rule that fires wins" is only well defined if two
			// rules armed in the same millisecond still have an order.
			id: createInjectionRuleId(this.#random),
			target: request.target,
			trigger: request.trigger,
			preset: request.preset,
			retryAfterSeconds: request.retryAfterSeconds,
			regainAccessMinutes: request.regainAccessMinutes,
			custom: request.custom,
		});

		this.#announce(rule, "created");

		return rule;
	}

	/** Answers with the rule that is gone, so the caller can name it in a toast or a log. */
	async delete(id: string): Promise<InjectionRuleRecord> {
		const rule = await this.#repositories.injectionRules.findById(id);

		if (rule === null) {
			throw controlNotFound(`no injection rule with id ${id}`, "unknown_injection_rule");
		}

		await this.#repositories.injectionRules.deleteById(id);
		this.#announce(rule, "deleted");

		return rule;
	}

	/**
	 * Runs the rules against one request.
	 *
	 * `target` is the endpoint class the caller classified the request into, or `null` when the
	 * request is on the Graph surface but in no class of its own — a `graph.all` rule still
	 * matches it.
	 */
	async evaluate(target: InjectionTarget | null): Promise<InjectionDecision | null> {
		const rules = await this.#repositories.injectionRules.list();
		const matching = rules.filter(rule => rule.target === "graph.all" || rule.target === target);

		if (matching.length === 0) {
			return null;
		}

		let fired: InjectionRuleRecord | null = null;

		for (const rule of matching) {
			const seen = rule.seen + 1;
			const isArms = fired === null && isArmed(rule.trigger, { seen, remaining: rule.remaining });
			const updated = await this.#repositories.injectionRules.updateCounters(rule.id, {
				seen,
				matches: isArms ? rule.matches + 1 : rule.matches,
				remaining: isArms && rule.trigger.kind === "next" ? Math.max((rule.remaining ?? 0) - 1, 0) : rule.remaining,
			});

			if (updated === null) {
				continue;
			}

			// Every rule the request touched is announced: the countdown in the UI is only live
			// if the frames that move it are sent.
			this.#announce(updated, "updated");

			if (isArms) {
				fired = updated;
			}
		}

		if (fired === null) {
			return null;
		}

		return {
			rule: fired,
			error: injectionResponse({
				preset: fired.preset,
				retryAfterSeconds: fired.retryAfterSeconds,
				regainAccessMinutes: fired.regainAccessMinutes,
				custom: fired.custom,
				wabaId: await this.#usageWabaId(),
			}),
		};
	}
}
