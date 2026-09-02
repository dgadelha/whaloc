import {
	INBOUND_MEDIA_TYPES,
	REFERRAL_MEDIA_TYPES,
	REFERRAL_SOURCE_TYPES,
	type InboundMediaType,
	type Message,
	type ReferralMediaType,
	type ReferralSourceType,
} from "@whaloc/shared";
import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { describeError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { useToasts } from "../../store/store.tsx";
import {
	buildInboundRequest,
	emptyDraft,
	emptyExtras,
	hasExtras,
	type ComposerDraft,
	type ComposerExtras,
} from "./composer-payload.ts";
import { summarize } from "./message-bubble.tsx";

export interface ComposerProps {
	phoneNumberId: string;
	contactWaId: string;
	/** Set by the bubble menu; becomes the message's `context` node. */
	replyTo: Message | null;
	onClearReply: () => void;
	/** Set by the bubble menu's "React…"; switches the composer to the reaction form. */
	reactionTarget: Message | null;
	onClearReaction: () => void;
}

type Mode = ComposerDraft["kind"];

const MODES: { kind: Mode; label: string }[] = [
	{ kind: "text", label: "Text" },
	{ kind: "media", label: "Media" },
	{ kind: "location", label: "Location" },
	{ kind: "interactive", label: "Interactive" },
	{ kind: "button", label: "Button" },
	{ kind: "contacts", label: "Contacts" },
	{ kind: "reaction", label: "Reaction" },
	{ kind: "unsupported", label: "Unsupported (poll, etc.)" },
];

const EMOJI_PRESETS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** What a picked file most likely is, in Meta's vocabulary. */
export function mediaTypeOf(mimeType: string): InboundMediaType {
	if (mimeType.startsWith("image/")) {
		return mimeType === "image/webp" ? "sticker" : "image";
	}

	if (mimeType.startsWith("video/")) {
		return "video";
	}

	if (mimeType.startsWith("audio/")) {
		return "audio";
	}

	return "document";
}

interface ExtrasProps {
	extras: ComposerExtras;
	onChange: (next: ComposerExtras) => void;
}

/**
 * The **context riders** (SPEC §5), collapsed by default because most messages carry none.
 *
 * They are not a message type — a forwarded location and a text from an ad are both perfectly
 * ordinary messages with something extra on them — so they sit under the type tabs rather than
 * beside them, and survive a mode switch. Each mini-form is behind its own checkbox: an empty
 * `referral` is not the same thing as no referral, and Meta never sends a half-filled one.
 */
function ComposerExtrasPanel(props: ExtrasProps) {
	const { extras, onChange } = props;
	const bodyId = useId();
	const [isOpen, setIsOpen] = useState(false);
	const isActive = hasExtras(extras);
	const patchReferral = (patch: Partial<ComposerExtras["referral"]>): void => {
		onChange({ ...extras, referral: { ...extras.referral, ...patch } });
	};
	const patchProduct = (patch: Partial<ComposerExtras["referredProduct"]>): void => {
		onChange({ ...extras, referredProduct: { ...extras.referredProduct, ...patch } });
	};

	return (
		<div className="composer__extras">
			<button
				type="button"
				className="composer__extras-toggle"
				aria-expanded={isOpen}
				aria-controls={bodyId}
				onClick={() => {
					setIsOpen(open => !open);
				}}
			>
				<span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> Extras
				{isActive && <span className="badge badge--info">on</span>}
			</button>

			{isOpen && (
				<div id={bodyId} className="composer__extras-body">
					<div className="row row--wrap">
						<label className="checkbox">
							<input
								type="checkbox"
								checked={extras.forwarded}
								onChange={event => {
									onChange({ ...extras, forwarded: event.target.checked });
								}}
							/>
							context.forwarded
						</label>
						<label className="checkbox">
							<input
								type="checkbox"
								checked={extras.frequentlyForwarded}
								onChange={event => {
									onChange({ ...extras, frequentlyForwarded: event.target.checked });
								}}
							/>
							context.frequently_forwarded
						</label>
					</div>

					<label className="checkbox">
						<input
							type="checkbox"
							checked={extras.referral.enabled}
							onChange={event => {
								patchReferral({ enabled: event.target.checked });
							}}
						/>
						referral — the message came from a click-to-WhatsApp ad
					</label>

					{extras.referral.enabled && (
						<div className="composer__grid">
							<label className="field">
								<span className="field__label">source_url</span>
								<input
									className="input"
									value={extras.referral.sourceUrl}
									onChange={event => {
										patchReferral({ sourceUrl: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">source_type</span>
								<select
									className="select"
									value={extras.referral.sourceType}
									onChange={event => {
										patchReferral({ sourceType: event.target.value as ReferralSourceType });
									}}
								>
									{REFERRAL_SOURCE_TYPES.map(type => (
										<option key={type} value={type}>
											{type}
										</option>
									))}
								</select>
							</label>
							<label className="field">
								<span className="field__label">source_id</span>
								<input
									className="input mono"
									value={extras.referral.sourceId}
									onChange={event => {
										patchReferral({ sourceId: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">headline</span>
								<input
									className="input"
									value={extras.referral.headline}
									onChange={event => {
										patchReferral({ headline: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">body</span>
								<input
									className="input"
									value={extras.referral.body}
									onChange={event => {
										patchReferral({ body: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">media_type</span>
								<select
									className="select"
									value={extras.referral.mediaType}
									onChange={event => {
										patchReferral({ mediaType: event.target.value as "" | ReferralMediaType });
									}}
								>
									<option value="">none</option>
									{REFERRAL_MEDIA_TYPES.map(type => (
										<option key={type} value={type}>
											{type}
										</option>
									))}
								</select>
							</label>
							<label className="field">
								<span className="field__label">image_url</span>
								<input
									className="input"
									value={extras.referral.imageUrl}
									onChange={event => {
										patchReferral({ imageUrl: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">video_url</span>
								<input
									className="input"
									value={extras.referral.videoUrl}
									onChange={event => {
										patchReferral({ videoUrl: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">thumbnail_url</span>
								<input
									className="input"
									value={extras.referral.thumbnailUrl}
									onChange={event => {
										patchReferral({ thumbnailUrl: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">ctwa_clid</span>
								<input
									className="input mono"
									value={extras.referral.ctwaClid}
									onChange={event => {
										patchReferral({ ctwaClid: event.target.value });
									}}
								/>
							</label>
						</div>
					)}

					<label className="checkbox">
						<input
							type="checkbox"
							checked={extras.referredProduct.enabled}
							onChange={event => {
								patchProduct({ enabled: event.target.checked });
							}}
						/>
						context.referred_product — the message is about a catalog item
					</label>

					{extras.referredProduct.enabled && (
						<div className="composer__grid">
							<label className="field">
								<span className="field__label">catalog_id</span>
								<input
									className="input mono"
									value={extras.referredProduct.catalogId}
									onChange={event => {
										patchProduct({ catalogId: event.target.value });
									}}
								/>
							</label>
							<label className="field">
								<span className="field__label">product_retailer_id</span>
								<input
									className="input mono"
									value={extras.referredProduct.productRetailerId}
									onChange={event => {
										patchProduct({ productRetailerId: event.target.value });
									}}
								/>
							</label>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * The user side of the conversation (SPEC §5): everything `POST /api/inbound` accepts, one
 * mode per inbound type. The payload itself is built by `composer-payload.ts` — this is the
 * form around it, the media upload that has to happen first, the reply/reaction context the
 * bubble menu sets, and the collapsed **Extras** panel holding the context riders.
 */
export function Composer(props: ComposerProps) {
	const toasts = useToasts();
	const [mode, setMode] = useState<Mode>("text");
	const [draft, setDraft] = useState<ComposerDraft>(() => emptyDraft("text"));
	// Riders outlive a mode switch: they describe how the message arrived, not what is in it.
	const [extras, setExtras] = useState<ComposerExtras>(emptyExtras);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const { reactionTarget, onClearReaction } = props;

	useEffect(() => {
		if (reactionTarget === null) {
			return;
		}

		setMode("reaction");
		setDraft({ kind: "reaction", messageId: reactionTarget.id, emoji: "👍" });
	}, [reactionTarget]);

	const switchMode = (next: Mode): void => {
		setMode(next);
		setDraft(emptyDraft(next));
		setError(null);

		if (next !== "reaction") {
			onClearReaction();
		}
	};

	const update = (patch: Partial<ComposerDraft>): void => {
		setDraft(current => ({ ...current, ...patch }) as ComposerDraft);
	};

	const send = (): void => {
		const built = buildInboundRequest(
			{
				phoneNumberId: props.phoneNumberId,
				from: props.contactWaId,
				replyTo: props.replyTo?.id,
			},
			draft,
			extras,
		);

		if (!built.ok) {
			setError(built.error);

			return;
		}

		setError(null);
		setBusy(true);

		const nextDraft = emptyDraft(mode, draft.kind === "media" ? draft.mediaType : "image");

		void (async () => {
			try {
				await api.sendInbound(built.request);
				setDraft(nextDraft);
				props.onClearReply();
				onClearReaction();
			} catch (error_) {
				setError(describeError(error_));
				toasts.error(error_);
			} finally {
				setBusy(false);
			}
		})();
	};

	const upload = (event: ChangeEvent<HTMLInputElement>): void => {
		const file = event.target.files?.[0];

		if (file === undefined) {
			return;
		}

		setBusy(true);

		void (async () => {
			try {
				const media = await api.uploadInboundMedia(props.phoneNumberId, file);

				setError(null);
				setDraft({
					kind: "media",
					mediaType: mediaTypeOf(media.mimeType),
					mediaId: media.id,
					caption: "",
					filename: file.name,
				});
				setMode("media");
			} catch (error_) {
				toasts.error(error_);
			} finally {
				setBusy(false);
			}
		})();
	};

	const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key !== "Enter" || event.shiftKey) {
			return;
		}

		event.preventDefault();
		send();
	};

	return (
		<form
			className="composer"
			onSubmit={event => {
				event.preventDefault();
				send();
			}}
		>
			{props.replyTo !== null && (
				<div className="composer__context">
					<span className="chip">replying to</span>
					<span className="composer__context-text">{summarize(props.replyTo)}</span>
					<button type="button" className="button button--ghost button--sm" onClick={props.onClearReply}>
						clear
					</button>
				</div>
			)}

			<div className="composer__modes" role="tablist" aria-label="Message type">
				{MODES.map(entry => (
					<button
						key={entry.kind}
						type="button"
						role="tab"
						aria-selected={mode === entry.kind}
						className={clsx("composer__mode", mode === entry.kind && "is-active")}
						onClick={() => {
							switchMode(entry.kind);
						}}
					>
						{entry.label}
					</button>
				))}
			</div>

			<div className="composer__fields">
				{draft.kind === "text" && (
					<textarea
						className="input composer__text"
						aria-label="Message text"
						placeholder="Message as the user — Enter sends, Shift+Enter adds a line"
						value={draft.body}
						rows={2}
						onChange={event => {
							update({ body: event.target.value });
						}}
						onKeyDown={onTextKeyDown}
					/>
				)}

				{draft.kind === "media" && (
					<div className="composer__grid">
						<div className="row">
							<input
								ref={fileInput}
								type="file"
								className="visually-hidden"
								aria-label="Attach a file"
								onChange={upload}
							/>
							<button
								type="button"
								className="button"
								onClick={() => {
									fileInput.current?.click();
								}}
							>
								Choose file…
							</button>
							<span className="faint mono">
								{draft.mediaId === "" ? "no media uploaded yet" : `media ${draft.mediaId}`}
							</span>
						</div>
						<label className="field">
							<span className="field__label">Type</span>
							<select
								className="select"
								value={draft.mediaType}
								onChange={event => {
									update({ mediaType: event.target.value as InboundMediaType });
								}}
							>
								{INBOUND_MEDIA_TYPES.map(type => (
									<option key={type} value={type}>
										{type}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span className="field__label">Caption</span>
							<input
								className="input"
								value={draft.caption}
								onChange={event => {
									update({ caption: event.target.value });
								}}
							/>
						</label>
						<label className="field">
							<span className="field__label">Filename</span>
							<input
								className="input"
								value={draft.filename}
								onChange={event => {
									update({ filename: event.target.value });
								}}
							/>
						</label>
					</div>
				)}

				{draft.kind === "location" && (
					<div className="composer__grid">
						<label className="field">
							<span className="field__label">Latitude</span>
							<input
								className="input"
								inputMode="decimal"
								value={draft.latitude}
								onChange={event => {
									update({ latitude: event.target.value });
								}}
							/>
						</label>
						<label className="field">
							<span className="field__label">Longitude</span>
							<input
								className="input"
								inputMode="decimal"
								value={draft.longitude}
								onChange={event => {
									update({ longitude: event.target.value });
								}}
							/>
						</label>
						<label className="field">
							<span className="field__label">Name</span>
							<input
								className="input"
								value={draft.name}
								onChange={event => {
									update({ name: event.target.value });
								}}
							/>
						</label>
						<label className="field">
							<span className="field__label">Address</span>
							<input
								className="input"
								value={draft.address}
								onChange={event => {
									update({ address: event.target.value });
								}}
							/>
						</label>
					</div>
				)}

				{draft.kind === "interactive" && (
					<div className="composer__grid">
						<label className="field">
							<span className="field__label">Reply kind</span>
							<select
								className="select"
								value={draft.replyType}
								onChange={event => {
									update({ replyType: event.target.value as "button_reply" | "list_reply" });
								}}
							>
								<option value="button_reply">button_reply</option>
								<option value="list_reply">list_reply</option>
							</select>
						</label>
						<label className="field">
							<span className="field__label">Id</span>
							<input
								className="input"
								value={draft.id}
								placeholder="the ID the template defined"
								onChange={event => {
									update({ id: event.target.value });
								}}
							/>
						</label>
						<label className="field">
							<span className="field__label">Title</span>
							<input
								className="input"
								value={draft.title}
								onChange={event => {
									update({ title: event.target.value });
								}}
							/>
						</label>
						{draft.replyType === "list_reply" && (
							<label className="field">
								<span className="field__label">Description</span>
								<input
									className="input"
									value={draft.description}
									onChange={event => {
										update({ description: event.target.value });
									}}
								/>
							</label>
						)}
					</div>
				)}

				{draft.kind === "button" && (
					<div className="composer__grid">
						<label className="field">
							<span className="field__label">Payload</span>
							<input
								className="input"
								value={draft.payload}
								onChange={event => {
									update({ payload: event.target.value });
								}}
							/>
						</label>
						<label className="field">
							<span className="field__label">Text</span>
							<input
								className="input"
								value={draft.text}
								onChange={event => {
									update({ text: event.target.value });
								}}
							/>
						</label>
					</div>
				)}

				{draft.kind === "contacts" && (
					<label className="field">
						<span className="field__label">Contact cards (JSON)</span>
						<textarea
							className="textarea"
							value={draft.json}
							rows={8}
							onChange={event => {
								update({ json: event.target.value });
							}}
						/>
					</label>
				)}

				{draft.kind === "unsupported" && (
					<p className="faint">
						Sends a message the app under test cannot render: <code>type: &quot;unsupported&quot;</code> with
						Meta&apos;s <code>131051</code> error node and nothing else. It is what a poll — or whatever WhatsApp ships
						next — looks like to an older API version.
					</p>
				)}

				{draft.kind === "reaction" && (
					<div className="composer__grid">
						<label className="field">
							<span className="field__label">Message ID</span>
							<input
								className="input mono"
								value={draft.messageId}
								placeholder="wamid…"
								onChange={event => {
									update({ messageId: event.target.value });
								}}
							/>
						</label>
						<label className="field">
							<span className="field__label">Emoji</span>
							<input
								className="input"
								value={draft.emoji}
								placeholder="leave empty to remove the reaction"
								onChange={event => {
									update({ emoji: event.target.value });
								}}
							/>
						</label>
						<div className="composer__emoji">
							{EMOJI_PRESETS.map(emoji => (
								<button
									key={emoji}
									type="button"
									className="composer__emoji-button"
									aria-label={`React ${emoji}`}
									onClick={() => {
										update({ emoji });
									}}
								>
									{emoji}
								</button>
							))}
						</div>
					</div>
				)}
			</div>

			<ComposerExtrasPanel extras={extras} onChange={setExtras} />

			{error !== null && <p className="composer__error">{error}</p>}

			<div className="composer__actions">
				<span className="faint">
					acting as <strong>{props.contactWaId}</strong>
				</span>
				<span className="spacer" />
				<button type="submit" className="button button--primary" disabled={busy}>
					{busy ? "sending…" : "Send"}
				</button>
			</div>
		</form>
	);
}
