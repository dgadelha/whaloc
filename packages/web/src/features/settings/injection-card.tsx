import {
	DEFAULT_REGAIN_ACCESS_MINUTES,
	DEFAULT_RETRY_AFTER_SECONDS,
	INJECTION_PRESETS,
	INJECTION_TARGETS,
	INJECTION_TRIGGER_KINDS,
	isRuleArmed,
	type InjectionPreset,
	type InjectionRule,
	type InjectionRuleCreateRequest,
	type InjectionTarget,
	type InjectionTrigger,
	type InjectionTriggerKind,
} from "@whaloc/shared";
import clsx from "clsx";
import { useState } from "react";
import { api } from "../../api/endpoints.ts";
import { useAction, useAppState, useDispatch, useToasts } from "../../store/store.tsx";

/**
 * Error injection, as Settings drives it (SPEC §4).
 *
 * Everything here is deterministic: a rule fires on the requests its trigger names and on nothing
 * else, and the counters come from the server — the countdown moves because the server announces
 * it over `/api/ws`, not because the browser is guessing.
 */

/** What each endpoint class actually covers, spelled out so the dropdown is not a riddle. */
const TARGET_LABELS: Record<InjectionTarget, string> = {
	"messages.send": "messages.send — POST /{phone-number-id}/messages",
	"media.upload": "media.upload — POST /{phone-number-id}/media",
	"media.resolve": "media.resolve — GET /{media-id}?phone_number_id=",
	"media.download": "media.download — GET /whaloc-media/{token}",
	"templates.create": "templates.create — POST /{waba-id}/message_templates",
	"templates.list": "templates.list — GET /{waba-id}/message_templates",
	"graph.all": "graph.all — every Graph request",
};

const PRESET_LABELS: Record<InjectionPreset, string> = {
	rate_limit_429: "rate_limit_429 — 429, code 130429, Retry-After",
	throughput_131056: "throughput_131056 — 400, code 131056",
	spam_rate_4: "spam_rate_4 — 429, code 4, Retry-After",
	server_error_500: "server_error_500 — 500, code 1",
	custom: "custom — write the envelope yourself",
};

const TRIGGER_LABELS: Record<InjectionTriggerKind, string> = {
	always: "always",
	next: "next N requests",
	every: "every Nth request",
};

/** The two 429 presets are the only ones that emit throttling headers (SPEC §1.11). */
function hasThrottleHeaders(preset: InjectionPreset): boolean {
	return preset === "rate_limit_429" || preset === "spam_rate_4";
}

function describeTrigger(rule: InjectionRule): string {
	switch (rule.trigger.kind) {
		case "always": {
			return "always";
		}

		case "next": {
			return rule.exhausted
				? `next ${String(rule.trigger.count)} — spent`
				: `next ${String(rule.trigger.count)} — ${String(rule.remaining ?? 0)} left`;
		}

		case "every": {
			return rule.trigger.nth === 1 ? "every request" : `every ${String(rule.trigger.nth)} requests`;
		}
	}
}

function RuleRow(props: { rule: InjectionRule }) {
	const { rule } = props;
	const run = useAction();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const isArmed = isRuleArmed(rule);

	return (
		<tr>
			<td className="mono">{rule.target}</td>
			<td className="mono">{rule.preset}</td>
			<td>
				<span className={clsx("badge", isArmed ? "badge--danger" : "")}>{describeTrigger(rule)}</span>
			</td>
			<td className="faint">
				{rule.matches} fired / {rule.seen} seen
				{hasThrottleHeaders(rule.preset) && (
					<>
						{" · "}
						<span className="mono">
							Retry-After {rule.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS}s,{" "}
							{rule.regainAccessMinutes ?? DEFAULT_REGAIN_ACCESS_MINUTES}min
						</span>
					</>
				)}
			</td>
			<td>
				<button
					type="button"
					className="button button--danger"
					aria-label={`Delete rule ${rule.target} ${rule.preset}`}
					onClick={() => {
						run(async () => {
							const deleted = await api.deleteInjectionRule(rule.id);

							dispatch({
								type: "ws/event",
								event: { type: "injection.changed", payload: { rule: deleted, event: "deleted" } },
							});
							toasts.info(`${deleted.target} is failing no more`);
						});
					}}
				>
					Delete
				</button>
			</td>
		</tr>
	);
}

/** The trigger's numeric argument; `always` has none. */
function triggerOf(kind: InjectionTriggerKind, count: number): InjectionTrigger {
	switch (kind) {
		case "next": {
			return { kind: "next", count };
		}

		case "every": {
			return { kind: "every", nth: count };
		}

		default: {
			return { kind: "always" };
		}
	}
}

function AddRuleForm() {
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [target, setTarget] = useState<InjectionTarget>("messages.send");
	const [preset, setPreset] = useState<InjectionPreset>("rate_limit_429");
	const [triggerKind, setTriggerKind] = useState<InjectionTriggerKind>("next");
	const [count, setCount] = useState("3");
	const [retryAfter, setRetryAfter] = useState(String(DEFAULT_RETRY_AFTER_SECONDS));
	const [regainAccess, setRegainAccess] = useState(String(DEFAULT_REGAIN_ACCESS_MINUTES));
	const [customStatus, setCustomStatus] = useState("400");
	const [customCode, setCustomCode] = useState("131047");
	const [customMessage, setCustomMessage] = useState("(#131047) Re-engagement message");

	const submit = (): void => {
		const parsedCount = Number(count);

		if (triggerKind !== "always" && (!Number.isSafeInteger(parsedCount) || parsedCount < 1)) {
			toasts.info("A next-N or every-Nth trigger needs a whole number of at least 1");

			return;
		}

		const body: InjectionRuleCreateRequest = {
			target,
			preset,
			trigger: triggerOf(triggerKind, parsedCount),
			...(hasThrottleHeaders(preset) && {
				retryAfterSeconds: Number(retryAfter),
				regainAccessMinutes: Number(regainAccess),
			}),
			...(preset === "custom" && {
				custom: { httpStatus: Number(customStatus), code: Number(customCode), message: customMessage },
			}),
		};

		run(async () => {
			const rule = await api.createInjectionRule(body);

			dispatch({ type: "ws/event", event: { type: "injection.changed", payload: { rule, event: "created" } } });
			toasts.info(`${rule.target} will answer ${rule.preset}`);
		});
	};

	return (
		<form
			className="stack"
			onSubmit={event => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="row row--wrap">
				<label className="field">
					<span className="field__label">Target</span>
					<select
						className="select"
						aria-label="Rule target"
						value={target}
						onChange={changed => {
							setTarget(changed.target.value as InjectionTarget);
						}}
					>
						{INJECTION_TARGETS.map(option => (
							<option key={option} value={option}>
								{TARGET_LABELS[option]}
							</option>
						))}
					</select>
				</label>

				<label className="field">
					<span className="field__label">Response</span>
					<select
						className="select"
						aria-label="Rule preset"
						value={preset}
						onChange={changed => {
							setPreset(changed.target.value as InjectionPreset);
						}}
					>
						{INJECTION_PRESETS.map(option => (
							<option key={option} value={option}>
								{PRESET_LABELS[option]}
							</option>
						))}
					</select>
				</label>

				<label className="field">
					<span className="field__label">Trigger</span>
					<select
						className="select"
						aria-label="Rule trigger"
						value={triggerKind}
						onChange={changed => {
							setTriggerKind(changed.target.value as InjectionTriggerKind);
						}}
					>
						{INJECTION_TRIGGER_KINDS.map(option => (
							<option key={option} value={option}>
								{TRIGGER_LABELS[option]}
							</option>
						))}
					</select>
				</label>

				{triggerKind !== "always" && (
					<label className="field">
						<span className="field__label">{triggerKind === "next" ? "How many" : "Every"}</span>
						<input
							className="input settings__input--narrow"
							aria-label="Trigger count"
							inputMode="numeric"
							value={count}
							onChange={changed => {
								setCount(changed.target.value);
							}}
						/>
					</label>
				)}
			</div>

			{hasThrottleHeaders(preset) && (
				<div className="row row--wrap">
					<label className="field">
						<span className="field__label">Retry-After (seconds)</span>
						<input
							className="input settings__input--narrow"
							aria-label="Retry-After seconds"
							inputMode="numeric"
							value={retryAfter}
							onChange={changed => {
								setRetryAfter(changed.target.value);
							}}
						/>
					</label>
					<label className="field">
						<span className="field__label">Regain access (minutes)</span>
						<input
							className="input settings__input--narrow"
							aria-label="Estimated time to regain access minutes"
							inputMode="numeric"
							value={regainAccess}
							onChange={changed => {
								setRegainAccess(changed.target.value);
							}}
						/>
					</label>
				</div>
			)}

			{preset === "custom" && (
				<div className="row row--wrap">
					<label className="field">
						<span className="field__label">HTTP status</span>
						<input
							className="input settings__input--narrow"
							aria-label="Custom HTTP status"
							inputMode="numeric"
							value={customStatus}
							onChange={changed => {
								setCustomStatus(changed.target.value);
							}}
						/>
					</label>
					<label className="field">
						<span className="field__label">Meta code</span>
						<input
							className="input settings__input--narrow"
							aria-label="Custom error code"
							inputMode="numeric"
							value={customCode}
							onChange={changed => {
								setCustomCode(changed.target.value);
							}}
						/>
					</label>
					<label className="field">
						<span className="field__label">Message</span>
						<input
							className="input settings__input"
							aria-label="Custom error message"
							value={customMessage}
							onChange={changed => {
								setCustomMessage(changed.target.value);
							}}
						/>
					</label>
				</div>
			)}

			<div className="row">
				<button type="submit" className="button button--danger">
					Arm rule
				</button>
			</div>
		</form>
	);
}

export function InjectionCard() {
	const { injectionRules } = useAppState();
	const rules = injectionRules ?? [];
	const armed = rules.filter(rule => isRuleArmed(rule)).length;

	return (
		<div className="card stack">
			{/* The count the section heading used to carry; a forgotten rule has to be visible from
			    the top of the card, not only from the shell's badge (SPEC §4). */}
			{armed > 0 && (
				<div className="row">
					<span className="badge badge--danger">{armed} armed</span>
				</div>
			)}
			<p className="muted">
				Deterministic failures on the Graph surface: a rule says which endpoint class to fail, when, and with which Meta
				envelope. Nothing here is random — a rule fires on exactly the requests its trigger names. Rules are evaluated
				in the order below and the first one that fires answers.
			</p>

			{rules.length === 0 ? (
				<p className="empty">No rules armed — the Graph surface is behaving.</p>
			) : (
				<table className="table">
					<thead>
						<tr>
							<th>Target</th>
							<th>Response</th>
							<th>Trigger</th>
							<th>Counters</th>
							<th aria-label="Actions" />
						</tr>
					</thead>
					<tbody>
						{rules.map(rule => (
							<RuleRow key={rule.id} rule={rule} />
						))}
					</tbody>
				</table>
			)}

			<hr className="divider" />
			<AddRuleForm />

			<p className="faint">
				A <code>next N</code> rule keeps its spent row so the countdown is readable after the fact; delete it, or{" "}
				<code>POST /api/reset</code>, to disarm everything.
			</p>
		</div>
	);
}
