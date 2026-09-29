import type { JsonObject, UploadDescriptor } from "@whaloc/shared";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/endpoints.ts";
import { LocationCard } from "../chats/location-card.tsx";
import { LinkedMedia, MediaPreview, mediaSrc } from "../chats/media-preview.tsx";
import { asArray, asRecord, asString } from "../../lib/json.ts";
import {
	resolvePlaceholder,
	type FillableComponent,
	type HeaderMediaParameter,
	type TemplateFill,
} from "./template-fill.ts";

/**
 * A template's components rendered the way WhatsApp lays them out: header, body, footer,
 * buttons. The Templates view renders the definition on its own, every placeholder marked so
 * it is obvious what a send must supply; a chat bubble passes the send's {@link TemplateFill}
 * and gets what the recipient saw — values in place, and only what the send left out marked.
 */

/** Split keeps the delimiters, so the two patterns are the same one with and without anchors. */
const PLACEHOLDER_SPLIT = /(\{\{\s*[\w-]+\s*\}\})/g;
const PLACEHOLDER_EXACT = /^\{\{\s*[\w-]+\s*\}\}$/;

function placeholderName(part: string): string {
	return part.slice(2, -2).trim();
}

/**
 * `{{1}}` / `{{order_id}}` — the parts a send has to fill in (SPEC §2). With `resolve`, a
 * placeholder the send filled is plain text, like on the phone; one it did not stays marked.
 */
export function HighlightedText(props: { text: string; resolve?: (placeholder: string) => string | null }) {
	return (
		<>
			{props.text.split(PLACEHOLDER_SPLIT).map((part, index) => {
				if (!PLACEHOLDER_EXACT.test(part)) {
					return <Fragment key={`text-${String(index)}`}>{part}</Fragment>;
				}

				const value = props.resolve?.(placeholderName(part)) ?? null;

				return value === null ? (
					<mark key={`${part}-${String(index)}`} className="placeholder">
						{part}
					</mark>
				) : (
					<Fragment key={`${part}-${String(index)}`}>{value}</Fragment>
				);
			})}
		</>
	);
}

/** Resolved handles are cached for the session: a handle is immutable and the list re-renders. */
const uploads = new Map<string, UploadDescriptor>();

/**
 * The `example.header_handle` of a media header (SPEC §2.7), resolved to the bytes it names.
 *
 * A handle comes out of the Resumable Upload API and is not a media id, so it goes through
 * `GET /api/uploads?handle=…` rather than the media lookup. A handle that resolves to nothing —
 * which the Graph surface refuses at create time — falls back to the format label, because a
 * seeded or imported template may still carry one whose upload is gone.
 */
function HeaderMedia(props: { handle: string; format: string }) {
	const { handle, format } = props;
	const [upload, setUpload] = useState<UploadDescriptor | null>(() => uploads.get(handle) ?? null);

	useEffect(() => {
		const known = uploads.get(handle);

		if (known !== undefined) {
			setUpload(known);

			return;
		}

		const controller = new AbortController();

		void (async () => {
			try {
				const resolved = await api.getUpload(handle, { signal: controller.signal });

				uploads.set(handle, resolved);
				setUpload(resolved);
			} catch {
				// A handle nothing answers for is not an error worth a toast: the label below says
				// as much, and the components JSON beside the preview shows the handle itself.
			}
		})();

		return () => {
			controller.abort();
		};
	}, [handle]);

	if (upload === null) {
		return <div className="preview__media">{format.toLowerCase()} header</div>;
	}

	const src = mediaSrc(upload);

	if (upload.mimeType.startsWith("image/")) {
		return <img className="preview__media-image" src={src} alt={`${format.toLowerCase()} header`} loading="lazy" />;
	}

	if (upload.mimeType.startsWith("video/")) {
		return <video className="preview__media-image" src={src} controls preload="metadata" />;
	}

	return (
		<a className="preview__media" href={src} target="_blank" rel="noreferrer">
			{upload.fileName ?? `${format.toLowerCase()} header`}
		</a>
	);
}

function SentHeaderMedia(props: { sent: HeaderMediaParameter | null; format: string }) {
	const { sent, format } = props;

	if (sent?.format === "location") {
		return <LocationCard latitude={sent.latitude} longitude={sent.longitude} name={sent.name} address={sent.address} />;
	}

	if (sent !== null && sent.id !== null) {
		return <MediaPreview mediaId={sent.id} filename={sent.filename} />;
	}

	if (sent?.link == null) {
		return <div className="preview__media">no {format.toLowerCase()} sent</div>;
	}

	return <LinkedMedia type={sent.format} link={sent.link} filename={sent.filename} />;
}

function Header(props: { component: JsonObject; fill: TemplateFill | undefined }) {
	const { component, fill } = props;
	const format = asString(component["format"]) ?? "TEXT";

	if (format !== "TEXT") {
		// A sent message shows what the send attached, never the sample the template was reviewed
		// with: that sample is not what the recipient got.
		if (fill !== undefined) {
			return <SentHeaderMedia sent={fill.headerMedia} format={format} />;
		}

		const example = asRecord(component["example"]);
		const handle = asString(asArray(example?.["header_handle"])[0]);

		return handle === null ? (
			<div className="preview__media">{format.toLowerCase()} header</div>
		) : (
			// Keyed by handle: switching templates reuses this slot, and a lookup for the new
			// handle that fails must not leave the previous template's media on show.
			<HeaderMedia key={handle} handle={handle} format={format} />
		);
	}

	const text = asString(component["text"]);

	return text === null ? null : (
		<p className="preview__header">
			<FilledText text={text} component="header" fill={fill} />
		</p>
	);
}

function FilledText(props: { text: string; component: FillableComponent; fill: TemplateFill | undefined }) {
	const { fill, component } = props;

	return (
		<HighlightedText
			text={props.text}
			{...(fill !== undefined && { resolve: placeholder => fill.valueOf(component, placeholder) })}
		/>
	);
}

/** The definition's buttons, each labelled with its type — the Templates view's reading. */
function DefinitionButtons(props: { buttons: unknown[] }) {
	return (
		<div className="preview__buttons">
			{props.buttons.map((button, index) => {
				const node = asRecord(button);
				const label = asString(node?.["text"]) ?? "button";
				const kind = asString(node?.["type"]) ?? "";

				return (
					<span key={`${label}-${String(index)}`} className="preview__button">
						{label}
						{kind !== "" && <span className="faint mono"> {kind.toLowerCase()}</span>}
					</span>
				);
			})}
		</div>
	);
}

/**
 * The URL a button opens, its dynamic suffix (`https://…/{{1}}`) taken from the send's `button`
 * component — or `null` while a placeholder is still unfilled.
 */
function filledUrl(url: string, parameters: readonly JsonObject[]): string | null {
	const valueOf = (part: string): string | null => resolvePlaceholder("POSITIONAL", parameters, placeholderName(part));
	const isComplete = (url.match(PLACEHOLDER_SPLIT) ?? []).every(part => valueOf(part) !== null);

	return isComplete ? url.replaceAll(PLACEHOLDER_SPLIT, part => valueOf(part) ?? part) : null;
}

function ButtonRow(props: { icon: string; label: string; href?: string; detail?: ReactNode }) {
	const content: ReactNode = (
		<>
			<span className="template__button-icon" aria-hidden="true">
				{props.icon}
			</span>
			<span>{props.label}</span>
			{props.detail !== undefined && <span className="template__button-detail mono">{props.detail}</span>}
		</>
	);

	return props.href === undefined ? (
		<span className="template__button">{content}</span>
	) : (
		<a className="template__button" href={props.href} target="_blank" rel="noreferrer" title={props.href}>
			{content}
		</a>
	);
}

/**
 * The buttons as the recipient sees them: one full-width row each, with what tapping does.
 * Types beyond the common four (flows, catalogs, …) keep their label and a neutral icon.
 */
function SentButtons(props: { buttons: unknown[]; fill: TemplateFill }) {
	return (
		<div className="template__buttons">
			{props.buttons.map((button, index) => {
				const node = asRecord(button) ?? {};
				const kind = asString(node["type"])?.toUpperCase() ?? "";
				const text = asString(node["text"]);
				const key = `${kind}-${String(index)}`;
				// An OTP button is sent as `sub_type: "url"`, which is how authentication templates carry the code.
				const parameters = props.fill.buttonParameters(index, kind === "OTP" ? "url" : kind.toLowerCase());

				switch (kind) {
					case "QUICK_REPLY": {
						return <ButtonRow key={key} icon="↩" label={text ?? "reply"} />;
					}

					case "URL": {
						const url = asString(node["url"]);
						const href = url === null ? null : filledUrl(url, parameters);

						return (
							<ButtonRow
								key={key}
								icon="↗"
								label={text ?? "open"}
								{...(href !== null && { href })}
								{...(url !== null && href === null && { detail: <HighlightedText text={url} /> })}
							/>
						);
					}

					case "PHONE_NUMBER": {
						const phone = asString(node["phone_number"]);

						return (
							<ButtonRow key={key} icon="✆" label={text ?? "call"} {...(phone !== null && { href: `tel:${phone}` })} />
						);
					}

					case "COPY_CODE":
					case "OTP": {
						const code = parameters.map(
							parameter => asString(parameter["coupon_code"]) ?? asString(parameter["text"]),
						)[0];

						return <ButtonRow key={key} icon="⧉" label={text ?? "Copy code"} {...(code != null && { detail: code })} />;
					}

					default: {
						return <ButtonRow key={key} icon="•" label={text ?? (kind.toLowerCase() || "button")} />;
					}
				}
			})}
		</div>
	);
}

export interface TemplateContentProps {
	/** The stored definition: upper-case component types, placeholders in the text. */
	components: readonly JsonObject[];
	/** What a send supplied; omitted, the definition renders with its placeholders marked. */
	fill?: TemplateFill;
}

export function TemplateContent(props: TemplateContentProps) {
	const { fill } = props;

	return (
		<>
			{props.components.map((component, index) => {
				const type = asString(component["type"])?.toUpperCase() ?? "";
				const text = asString(component["text"]);
				const key = `${type}-${String(index)}`;

				switch (type) {
					case "HEADER": {
						return <Header key={key} component={component} fill={fill} />;
					}

					case "BODY": {
						return (
							<p key={key} className="preview__body">
								{text === null ? (
									<span className="faint">no body text</span>
								) : (
									<FilledText text={text} component="body" fill={fill} />
								)}
							</p>
						);
					}

					case "FOOTER": {
						return (
							<p key={key} className="preview__footer faint">
								{text ?? ""}
							</p>
						);
					}

					case "BUTTONS": {
						const buttons = asArray(component["buttons"]);

						return fill === undefined ? (
							<DefinitionButtons key={key} buttons={buttons} />
						) : (
							<SentButtons key={key} buttons={buttons} fill={fill} />
						);
					}

					default: {
						return (
							<p key={key} className="faint mono">
								{type || "component"}
							</p>
						);
					}
				}
			})}
		</>
	);
}
