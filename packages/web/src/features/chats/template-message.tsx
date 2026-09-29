import type { JsonObject, Message, TemplateSnapshot } from "@whaloc/shared";
import { useState } from "react";
import { JsonBlock } from "../../components/json-block.tsx";
import { asArray, asString, readString } from "../../lib/json.ts";
import { useAppState } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import { TemplateContent } from "../templates/template-content.tsx";
import { createTemplateFill } from "../templates/template-fill.ts";

/**
 * An outbound `template` message, rendered as the recipient saw it (SPEC §2.5).
 *
 * The send only names the template and carries its parameters; the text they fill is the
 * definition's. The server freezes the definition the send was validated against on the
 * message, so that is what renders — not whatever the template says today. A message stored
 * before whaloc kept one borrows the definition the store already holds for that WABA, name
 * and language, labelled as such; with neither, the bubble shows what it always did.
 */

interface Definition {
	snapshot: TemplateSnapshot;
	/** `true` when it is today's template rather than the one the message was sent with. */
	current: boolean;
}

function currentDefinition(
	state: AppState,
	phoneNumberId: string,
	name: string | null,
	language: string | null,
): TemplateSnapshot | null {
	const wabaId = state.server?.wabas.find(waba => {
		return waba.phoneNumbers.some(phoneNumber => phoneNumber.id === phoneNumberId);
	})?.id;
	const template = state.templates?.find(candidate => {
		return candidate.wabaId === wabaId && candidate.name === name && candidate.language === language;
	});

	return template === undefined ? null : { parameterFormat: template.parameterFormat, components: template.components };
}

function useDefinition(message: Message, name: string | null, language: string | null): Definition | null {
	const state = useAppState();

	if (message.templateSnapshot !== undefined && message.templateSnapshot !== null) {
		return { snapshot: message.templateSnapshot, current: false };
	}

	const current = currentDefinition(state, message.phoneNumberId, name, language);

	return current === null ? null : { snapshot: current, current: true };
}

export function TemplateMessage(props: { message: Message; node: JsonObject }) {
	const { message, node } = props;
	const name = asString(node["name"]);
	const language = readString(node, "language", "code");
	const sendComponents = asArray(node["components"]);
	const definition = useDefinition(message, name, language);
	const [showRaw, setShowRaw] = useState(false);

	if (definition === null) {
		return (
			<div className="stack">
				<div className="row row--wrap">
					<span className="chip">template</span>
					<span className="bubble__text">{name ?? "?"}</span>
					<span className="faint mono">{language ?? ""}</span>
				</div>
				{sendComponents.length > 0 && <JsonBlock value={sendComponents} className="bubble__json" />}
			</div>
		);
	}

	return (
		<div className="bubble__template">
			<TemplateContent
				components={definition.snapshot.components}
				fill={createTemplateFill(definition.snapshot.parameterFormat, sendComponents)}
			/>
			<div className="template__meta faint mono">
				<span>
					template · {name ?? "?"} · {language ?? "?"}
				</span>
				{definition.current && (
					<span title="This message was stored without the definition it was sent with; this is the template as it stands now.">
						· current definition
					</span>
				)}
				<button
					type="button"
					className="template__raw-toggle"
					aria-expanded={showRaw}
					onClick={() => {
						setShowRaw(open => !open);
					}}
				>
					{showRaw ? "hide raw" : "raw"}
				</button>
			</div>
			{showRaw && <JsonBlock value={node} className="bubble__json" />}
		</div>
	);
}
