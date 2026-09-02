import type { JsonObject, Message } from "@whaloc/shared";
import { JsonBlock } from "../../components/json-block.tsx";
import { asArray, asNumber, asRecord, asString, readString } from "../../lib/json.ts";
import { MediaPreview } from "./media-preview.tsx";

/**
 * Renders the type-named node Meta puts in a webhook (SPEC §5) the way WhatsApp would show
 * it. Both directions land here: the app under test sends templates and interactive menus,
 * the UI sends replies and reactions, and anything this does not model falls back to the JSON
 * — which is still the most useful thing a dev tool can show.
 */

function Caption(props: { text: string | null }) {
	return props.text === null ? null : <p className="bubble__text">{props.text}</p>;
}

function MediaNode(props: { message: Message; node: JsonObject }) {
	const { node, message } = props;
	const id = asString(node["id"]);
	const link = asString(node["link"]);
	const caption = asString(node["caption"]);
	const filename = asString(node["filename"]);

	return (
		<>
			{id === null ? (
				link === null ? (
					<span className="faint">no media reference</span>
				) : (
					<a className="media__document" href={link} target="_blank" rel="noreferrer">
						{filename ?? link}
					</a>
				)
			) : (
				<MediaPreview
					mediaId={id}
					mimeType={asString(node["mime_type"])}
					caption={caption}
					filename={filename}
					sticker={message.type === "sticker"}
				/>
			)}
			<Caption text={caption} />
		</>
	);
}

function LocationNode(props: { node: JsonObject }) {
	const latitude = asNumber(props.node["latitude"]);
	const longitude = asNumber(props.node["longitude"]);
	const name = asString(props.node["name"]);
	const address = asString(props.node["address"]);

	return (
		<div className="bubble__location">
			<span className="bubble__location-pin" aria-hidden="true">
				◎
			</span>
			<div>
				{name !== null && <p className="bubble__text">{name}</p>}
				{address !== null && <p className="muted">{address}</p>}
				<p className="faint mono">
					{latitude?.toFixed(5) ?? "?"}, {longitude?.toFixed(5) ?? "?"}
				</p>
			</div>
		</div>
	);
}

function InteractiveNode(props: { node: JsonObject }) {
	const { node } = props;
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

	// Outbound: the menu the app under test sent.
	const buttons = asArray(asRecord(node["action"])?.["buttons"]).flatMap(button => {
		const title = readString(button, "reply", "title");

		return title === null ? [] : [title];
	});
	const rows = asArray(asRecord(node["action"])?.["sections"]).flatMap(section => {
		return asArray(asRecord(section)?.["rows"]).flatMap(row => {
			const title = readString(row, "title");

			return title === null ? [] : [title];
		});
	});

	return (
		<div className="bubble__interactive">
			{readString(node, "header", "text") !== null && (
				<p className="bubble__header">{readString(node, "header", "text")}</p>
			)}
			<Caption text={readString(node, "body", "text")} />
			{readString(node, "footer", "text") !== null && <p className="faint">{readString(node, "footer", "text")}</p>}
			<div className="bubble__buttons">
				{[...buttons, ...rows].map(label => (
					<span key={label} className="bubble__button">
						{label}
					</span>
				))}
			</div>
			<span className="faint mono">interactive · {kind ?? "?"}</span>
		</div>
	);
}

function TemplateNode(props: { node: JsonObject }) {
	const name = asString(props.node["name"]);
	const language = readString(props.node, "language", "code");
	const components = asArray(props.node["components"]);

	return (
		<div className="stack">
			<div className="row row--wrap">
				<span className="chip">template</span>
				<span className="bubble__text">{name ?? "?"}</span>
				<span className="faint mono">{language ?? ""}</span>
			</div>
			{components.length > 0 && <JsonBlock value={components} className="bubble__json" />}
		</div>
	);
}

function ContactsNode(props: { cards: unknown[] }) {
	return (
		<div className="stack">
			{props.cards.map((card, index) => {
				const name = readString(card, "name", "formatted_name") ?? readString(card, "name", "first_name") ?? "contact";
				const phones = asArray(asRecord(card)?.["phones"]).flatMap(phone => {
					const number = readString(phone, "phone");

					return number === null ? [] : [number];
				});

				return (
					<div key={`${name}-${String(index)}`} className="bubble__contact">
						<span className="bubble__contact-name">{name}</span>
						{phones.map(phone => (
							<span key={phone} className="faint mono">
								{phone}
							</span>
						))}
					</div>
				);
			})}
		</div>
	);
}

export function MessageBody(props: { message: Message }) {
	const { message } = props;
	const node = asRecord(message.payload[message.type]);

	switch (message.type) {
		case "text": {
			return <p className="bubble__text">{readString(message.payload, "text", "body") ?? ""}</p>;
		}

		case "image":
		case "video":
		case "audio":
		case "document":
		case "sticker": {
			return node === null ? <JsonBlock value={message.payload} /> : <MediaNode message={message} node={node} />;
		}

		case "location": {
			return node === null ? <JsonBlock value={message.payload} /> : <LocationNode node={node} />;
		}

		case "interactive": {
			return node === null ? <JsonBlock value={message.payload} /> : <InteractiveNode node={node} />;
		}

		case "template": {
			return node === null ? <JsonBlock value={message.payload} /> : <TemplateNode node={node} />;
		}

		case "button": {
			return (
				<div className="bubble__reply">
					<span className="bubble__reply-title">{readString(node, "text") ?? "button"}</span>
					<span className="chip">{readString(node, "payload") ?? ""}</span>
				</div>
			);
		}

		case "contacts": {
			return <ContactsNode cards={asArray(message.payload["contacts"])} />;
		}

		case "reaction": {
			return (
				<p className="bubble__text">
					<span className="bubble__reaction-emoji">{readString(node, "emoji") ?? "∅"}</span>{" "}
					<span className="faint">reacted to {readString(node, "message_id") ?? "a message"}</span>
				</p>
			);
		}

		/**
		 * Meta's placeholder for a message this API version cannot represent (SPEC §5). There is
		 * no body to render — the notice *is* the `errors[]` entry — so the bubble says what the
		 * app under test received and names the code it has to branch on.
		 */
		case "unsupported": {
			const error = asRecord(asArray(message.payload["errors"])[0]);

			return (
				<div className="bubble__unsupported">
					<span className="bubble__unsupported-icon" aria-hidden="true">
						⚠
					</span>
					<div>
						<p className="bubble__text">{asString(error?.["title"]) ?? "Message type unknown"}</p>
						<p className="faint">{readString(error, "error_data", "details") ?? "Message type is not supported."}</p>
						<span className="chip mono">{asNumber(error?.["code"]) ?? 131_051}</span>
					</div>
				</div>
			);
		}

		case "unknown": {
			return <JsonBlock value={message.payload} />;
		}
	}
}
