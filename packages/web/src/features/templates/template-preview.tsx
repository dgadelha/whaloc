import type { JsonObject, Template, UploadDescriptor } from "@whaloc/shared";
import { Fragment, useEffect, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { mediaSrc } from "../chats/media-preview.tsx";
import { asArray, asRecord, asString } from "../../lib/json.ts";

/** Split keeps the delimiters, so the two patterns are the same one with and without anchors. */
const PLACEHOLDER_SPLIT = /(\{\{\s*[\w-]+\s*\}\})/g;
const PLACEHOLDER_EXACT = /^\{\{\s*[\w-]+\s*\}\}$/;

/** `{{1}}` / `{{order_id}}` — the parts a send has to fill in (SPEC §2). */
export function HighlightedText(props: { text: string }) {
	return (
		<>
			{props.text.split(PLACEHOLDER_SPLIT).map((part, index) => {
				return PLACEHOLDER_EXACT.test(part) ? (
					<mark key={`${part}-${String(index)}`} className="placeholder">
						{part}
					</mark>
				) : (
					<Fragment key={`text-${String(index)}`}>{part}</Fragment>
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

function Header(props: { component: JsonObject }) {
	const format = asString(props.component["format"]) ?? "TEXT";

	if (format !== "TEXT") {
		const example = asRecord(props.component["example"]);
		const handle = asString(asArray(example?.["header_handle"])[0]);

		return handle === null ? (
			<div className="preview__media">{format.toLowerCase()} header</div>
		) : (
			<HeaderMedia handle={handle} format={format} />
		);
	}

	const text = asString(props.component["text"]);

	return text === null ? null : (
		<p className="preview__header">
			<HighlightedText text={text} />
		</p>
	);
}

function Buttons(props: { component: JsonObject }) {
	const buttons = asArray(props.component["buttons"]);

	return (
		<div className="preview__buttons">
			{buttons.map((button, index) => {
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
 * The template as WhatsApp would render it: header, body, footer, buttons, with every
 * placeholder marked so it is obvious what a send must supply.
 */
export function TemplatePreview(props: { template: Template }) {
	return (
		<div className="preview">
			{props.template.components.map((component, index) => {
				const type = asString(component["type"])?.toUpperCase() ?? "";
				const text = asString(component["text"]);
				const key = `${type}-${String(index)}`;

				switch (type) {
					case "HEADER": {
						return <Header key={key} component={component} />;
					}

					case "BODY": {
						return (
							<p key={key} className="preview__body">
								{text === null ? <span className="faint">no body text</span> : <HighlightedText text={text} />}
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
						return <Buttons key={key} component={component} />;
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
		</div>
	);
}
