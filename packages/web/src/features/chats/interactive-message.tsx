import type { JsonObject, Message } from "@whaloc/shared";
import { useRef, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { Dialog } from "../../components/dialog.tsx";
import { asArray, asRecord, asString, readString } from "../../lib/json.ts";
import { useToasts } from "../../store/store.tsx";
import { buildMenuChoiceRequest, type MenuChoice } from "./composer-payload.ts";

/**
 * An `interactive` message (SPEC §5). Inbound, it is the reply the user picked; outbound, it is
 * the menu the app under test sent, and its buttons are live: a tap sends the reply WhatsApp
 * would, through the same `POST /api/inbound` the composer uses, quoting the menu the way
 * Meta's `context` does on a real one.
 */

interface Replier {
	reply: (choice: MenuChoice) => void;
	/** A reply is in flight; the menu's choices are disabled until it lands or fails. */
	pending: boolean;
}

/**
 * Sends the reply a tap on `menu` produces; a refusal surfaces as a toast, like the composer's.
 * One reply at a time: the ref turns away a second tap in the same tick, before the disabled
 * state has rendered, so a double click cannot send the reply twice.
 */
function useReply(menu: Message): Replier {
	const toasts = useToasts();
	const inFlight = useRef(false);
	const [pending, setPending] = useState(false);

	const reply = (choice: MenuChoice) => {
		if (inFlight.current) {
			return;
		}

		const built = buildMenuChoiceRequest(
			{ phoneNumberId: menu.phoneNumberId, from: menu.contactWaId, replyTo: menu.id },
			choice,
		);

		if (!built.ok) {
			toasts.error(new Error(built.error));

			return;
		}

		inFlight.current = true;
		setPending(true);
		void (async () => {
			try {
				await api.sendInbound(built.request);
			} catch (error_) {
				toasts.error(error_);
			} finally {
				inFlight.current = false;
				setPending(false);
			}
		})();
	};

	return { reply, pending };
}

function ReplyButtons(props: { menu: Message; buttons: unknown[] }) {
	const { reply, pending } = useReply(props.menu);
	const choices = props.buttons.flatMap(button => {
		const id = readString(button, "reply", "id");
		const title = readString(button, "reply", "title");

		return id === null || title === null ? [] : [{ id, title }];
	});

	return (
		<div className="template__buttons">
			{choices.map(choice => (
				<button
					key={choice.id}
					type="button"
					className="template__button interactive__tap"
					title={choice.id}
					disabled={pending}
					onClick={() => {
						reply({ replyType: "button_reply", id: choice.id, title: choice.title, description: null });
					}}
				>
					<span className="template__button-icon" aria-hidden="true">
						↩
					</span>
					<span>{choice.title}</span>
				</button>
			))}
		</div>
	);
}

interface ListRow {
	id: string;
	title: string;
	description: string | null;
}

interface ListSection {
	title: string | null;
	rows: ListRow[];
}

function readSections(sections: unknown[]): ListSection[] {
	return sections.map(section => ({
		title: readString(section, "title"),
		rows: asArray(asRecord(section)?.["rows"]).flatMap(row => {
			const id = readString(row, "id");
			const title = readString(row, "title");

			return id === null || title === null ? [] : [{ id, title, description: readString(row, "description") }];
		}),
	}));
}

/** A list is one button under the bubble; tapping it opens the sections, and picking a row replies. */
function ListMenu(props: { menu: Message; label: string; sections: unknown[] }) {
	const { reply, pending } = useReply(props.menu);
	const [open, setOpen] = useState(false);
	const sections = readSections(props.sections);

	return (
		<div className="template__buttons">
			<button
				type="button"
				className="template__button interactive__tap"
				disabled={pending}
				onClick={() => {
					setOpen(true);
				}}
			>
				<span className="template__button-icon" aria-hidden="true">
					☰
				</span>
				<span>{props.label}</span>
			</button>
			{open && (
				<Dialog
					title={props.label}
					onClose={() => {
						setOpen(false);
					}}
				>
					<div className="interactive__list">
						{sections.map((section, index) => (
							<section key={`${section.title ?? ""}-${String(index)}`} className="interactive__section">
								{section.title !== null && <h3 className="interactive__section-title">{section.title}</h3>}
								{section.rows.map(row => (
									<button
										key={row.id}
										type="button"
										className="interactive__row"
										title={row.id}
										disabled={pending}
										onClick={() => {
											setOpen(false);
											reply({
												replyType: "list_reply",
												id: row.id,
												title: row.title,
												description: row.description,
											});
										}}
									>
										<span className="interactive__row-title">{row.title}</span>
										{row.description !== null && <span className="muted">{row.description}</span>}
									</button>
								))}
							</section>
						))}
					</div>
				</Dialog>
			)}
		</div>
	);
}

/** Only an absolute http(s) URL becomes a live link; any other scheme could act on the tester's machine. */
function isWebUrl(url: string): boolean {
	const protocol = URL.parse(url)?.protocol;

	return protocol === "http:" || protocol === "https:";
}

/** A `cta_url` produces no inbound message on WhatsApp either: its button only opens the link. */
function CtaUrl(props: { label: string; url: string }) {
	const content = (
		<>
			<span className="template__button-icon" aria-hidden="true">
				↗
			</span>
			<span>{props.label}</span>
		</>
	);

	return (
		<div className="template__buttons">
			{isWebUrl(props.url) ? (
				<a className="template__button" href={props.url} target="_blank" rel="noreferrer" title={props.url}>
					{content}
				</a>
			) : (
				<div className="template__button">
					{content}
					<span className="faint mono">{props.url}</span>
				</div>
			)}
		</div>
	);
}

export function InteractiveMessage(props: { message: Message; node: JsonObject }) {
	const { message, node } = props;
	const kind = asString(node["type"]);
	const reply = asRecord(node["button_reply"]) ?? asRecord(node["list_reply"]);

	// Inbound: the user tapped a button or picked a list row.
	if (reply !== null) {
		return (
			<div className="bubble__reply">
				<span className="bubble__reply-title">{asString(reply["title"]) ?? "reply"}</span>
				{asString(reply["description"]) !== null && <span className="muted">{asString(reply["description"])}</span>}
				<span className="chip">{asString(reply["id"]) ?? ""}</span>
			</div>
		);
	}

	const action = asRecord(node["action"]);
	const url = readString(action, "parameters", "url");

	return (
		<div className="bubble__interactive">
			{readString(node, "header", "text") !== null && (
				<p className="bubble__header">{readString(node, "header", "text")}</p>
			)}
			{readString(node, "body", "text") !== null && <p className="bubble__text">{readString(node, "body", "text")}</p>}
			{readString(node, "footer", "text") !== null && <p className="faint">{readString(node, "footer", "text")}</p>}
			{kind === "button" && <ReplyButtons menu={message} buttons={asArray(action?.["buttons"])} />}
			{kind === "list" && (
				<ListMenu
					menu={message}
					label={asString(action?.["button"]) ?? "Menu"}
					sections={asArray(action?.["sections"])}
				/>
			)}
			{kind === "cta_url" && url !== null && (
				<CtaUrl label={readString(action, "parameters", "display_text") ?? url} url={url} />
			)}
			<span className="faint mono">interactive · {kind ?? "?"}</span>
		</div>
	);
}
