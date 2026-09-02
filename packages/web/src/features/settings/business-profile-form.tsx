import {
	BUSINESS_PROFILE_LIMITS,
	BUSINESS_VERTICALS,
	type BusinessProfileUpdateRequest,
	type BusinessVertical,
	type PhoneNumber,
} from "@whaloc/shared";
import { useState } from "react";
import { api } from "../../api/endpoints.ts";
import { useDispatch, useToasts } from "../../store/store.tsx";

/**
 * The business profile a phone number publishes (SPEC §2.19), editable from Settings.
 *
 * The form posts **every** field, blanks included, because the control plane clears a field
 * given as an empty string — so what is on screen after a save is exactly what
 * `GET /{phoneNumberId}/whatsapp_business_profile` will answer. `profile_picture_url` is not an
 * input: it is set by posting a media id as `profile_picture_handle` on the Graph surface, so it
 * is shown here as a link and nothing more.
 */
export interface BusinessProfileFormProps {
	phoneNumber: PhoneNumber;
}

/** One row of the profile, so the six text fields are declared instead of copy-pasted. */
interface Field {
	key: "about" | "address" | "description" | "email";
	label: string;
	maxLength: number;
	placeholder: string;
}

const FIELDS: Field[] = [
	{
		key: "about",
		label: "About",
		maxLength: BUSINESS_PROFILE_LIMITS.about,
		placeholder: "Fresh groceries, delivered.",
	},
	{ key: "address", label: "Address", maxLength: BUSINESS_PROFILE_LIMITS.address, placeholder: "1 Market Street" },
	{
		key: "description",
		label: "Description",
		maxLength: BUSINESS_PROFILE_LIMITS.description,
		placeholder: "What the business does",
	},
	{ key: "email", label: "Email", maxLength: BUSINESS_PROFILE_LIMITS.email, placeholder: "hello@example.com" },
];

export function BusinessProfileForm(props: BusinessProfileFormProps) {
	const { businessProfile } = props.phoneNumber;
	const dispatch = useDispatch();
	const toasts = useToasts();
	const [draft, setDraft] = useState({
		about: businessProfile.about ?? "",
		address: businessProfile.address ?? "",
		description: businessProfile.description ?? "",
		email: businessProfile.email ?? "",
		vertical: businessProfile.vertical ?? "",
		websiteOne: businessProfile.websites?.[0] ?? "",
		websiteTwo: businessProfile.websites?.[1] ?? "",
	});
	const [saving, setSaving] = useState(false);

	const save = (): void => {
		setSaving(true);

		const body: BusinessProfileUpdateRequest = {
			about: draft.about.trim(),
			address: draft.address.trim(),
			description: draft.description.trim(),
			email: draft.email.trim(),
			vertical: draft.vertical as BusinessVertical | "",
			// An empty entry is dropped server-side, so two blanks clear the list.
			websites: [draft.websiteOne.trim(), draft.websiteTwo.trim()],
		};

		void (async () => {
			try {
				const updated = await api.updateBusinessProfile(props.phoneNumber.id, body);

				dispatch({
					type: "ws/event",
					event: { type: "phone_number.changed", payload: { phoneNumber: updated, event: "updated" } },
				});
				toasts.info(`business profile of ${updated.displayPhoneNumber} saved`);
			} catch (error) {
				toasts.error(error);
			} finally {
				setSaving(false);
			}
		})();
	};

	return (
		<form
			className="stack"
			onSubmit={submit => {
				submit.preventDefault();
				save();
			}}
		>
			<h4 className="card__title">Business profile</h4>

			<div className="settings__grid">
				{FIELDS.map(field => (
					<label className="field" key={field.key}>
						<span className="field__label">{field.label}</span>
						<input
							className="input"
							aria-label={`${field.label} of ${props.phoneNumber.displayPhoneNumber}`}
							maxLength={field.maxLength}
							placeholder={field.placeholder}
							value={draft[field.key]}
							onChange={changed => {
								setDraft(current => ({ ...current, [field.key]: changed.target.value }));
							}}
						/>
					</label>
				))}

				<label className="field">
					<span className="field__label">Vertical</span>
					<select
						className="select"
						aria-label={`Vertical of ${props.phoneNumber.displayPhoneNumber}`}
						value={draft.vertical}
						onChange={changed => {
							setDraft(current => ({ ...current, vertical: changed.target.value }));
						}}
					>
						<option value="">none</option>
						{BUSINESS_VERTICALS.map(vertical => (
							<option key={vertical} value={vertical}>
								{vertical}
							</option>
						))}
					</select>
				</label>

				<label className="field">
					<span className="field__label">Website 1</span>
					<input
						className="input"
						aria-label={`Website 1 of ${props.phoneNumber.displayPhoneNumber}`}
						maxLength={BUSINESS_PROFILE_LIMITS.website}
						placeholder="https://example.com"
						value={draft.websiteOne}
						onChange={changed => {
							setDraft(current => ({ ...current, websiteOne: changed.target.value }));
						}}
					/>
				</label>

				<label className="field">
					<span className="field__label">Website 2</span>
					<input
						className="input"
						aria-label={`Website 2 of ${props.phoneNumber.displayPhoneNumber}`}
						maxLength={BUSINESS_PROFILE_LIMITS.website}
						placeholder="https://shop.example.com"
						value={draft.websiteTwo}
						onChange={changed => {
							setDraft(current => ({ ...current, websiteTwo: changed.target.value }));
						}}
					/>
				</label>
			</div>

			<div className="row row--wrap">
				{businessProfile.profilePictureUrl === undefined ? (
					<span className="faint">
						No profile picture: post a media id as <code>profile_picture_handle</code> to set one.
					</span>
				) : (
					<a className="faint mono" href={businessProfile.profilePictureUrl} target="_blank" rel="noreferrer">
						profile picture
					</a>
				)}
				<span className="spacer" />
				<button type="submit" className="button button--primary" disabled={saving}>
					{saving ? "saving…" : "Save profile"}
				</button>
			</div>
		</form>
	);
}
