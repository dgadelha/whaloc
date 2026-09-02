import { isRuleArmed } from "@whaloc/shared";
import { NavLink } from "react-router";
import { useAppState } from "../store/store.tsx";

/**
 * The reminder that whaloc is deliberately failing requests (SPEC §4).
 *
 * It sits next to the connection indicator, and it is the reason an armed injection rule cannot
 * quietly confuse a developer: the *next* question after "why did my send just 429" is "did I
 * leave a rule on", and the answer is in the corner of every view, one click from the rule that
 * is doing it.
 *
 * Nothing is rendered when no rule can fire — an exhausted `next` rule is listed in Settings but
 * inert, so it does not raise the badge either.
 */
export function InjectionBadge() {
	const { injectionRules } = useAppState();
	const armed = (injectionRules ?? []).filter(rule => isRuleArmed(rule));

	if (armed.length === 0) {
		return null;
	}

	const label = armed.length === 1 ? "1 rule injecting errors" : `${String(armed.length)} rules injecting errors`;

	return (
		<NavLink
			to="/settings"
			className="connection connection--injecting"
			title={`Error injection is armed: ${armed.map(rule => rule.target).join(", ")}. Open Settings to remove it.`}
		>
			<span className="connection__dot" aria-hidden="true" />
			<span>{label}</span>
		</NavLink>
	);
}
