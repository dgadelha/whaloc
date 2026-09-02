import { metaIdSchema } from "@whaloc/shared";

/**
 * The optional **Meta ID** both create dialogs offer (SPEC §5).
 *
 * whaloc mints ids the way Meta does, which is right up until the app under test already has one
 * in its configuration: a `.env` pinning `WHATSAPP_PHONE_NUMBER_ID` to the production number is
 * far easier to point at whaloc than to edit. So the id is a field — blank means "mint one".
 *
 * It is one component rather than two identical `<label>`s because the two dialogs it appears in
 * are already a pair (Settings and the breadcrumb open the same ones), and a helper text that
 * drifted between them would be the first thing to go.
 */

/**
 * Whether a typed id could be sent, checked against the **same schema the server validates the
 * request with** — a typo is named in the field that made it instead of coming back as a 400.
 * Blank is always fine: it is how a caller asks for a generated id.
 */
export function metaIdError(value: string): string | null {
	const trimmed = value.trim();

	if (trimmed === "") {
		return null;
	}

	const parsed = metaIdSchema.safeParse(trimmed);

	return parsed.success ? null : `An ID ${parsed.error.issues[0]?.message ?? "is 1-32 digits"}`;
}

export interface MetaIdFieldProps {
	value: string;
	onChange: (value: string) => void;
	/** What the field is called in the accessibility tree, e.g. `New WABA ID`. */
	label: string;
}

export function MetaIdField(props: MetaIdFieldProps) {
	return (
		<label className="field">
			<span className="field__label">Meta ID</span>
			<input
				className="input mono"
				inputMode="numeric"
				placeholder="auto-generated"
				aria-label={props.label}
				value={props.value}
				onChange={changed => {
					props.onChange(changed.target.value);
				}}
			/>
			<span className="field__hint">
				Optional — set it to match your production ID. Digits only, at most 32 of them.
			</span>
		</label>
	);
}
