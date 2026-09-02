/**
 * The one place that decides when two phone numbers are the same one (SPEC §2, §7).
 *
 * whaloc stores `display_phone_number` the way it was given — `+55 11 91234-5678` reads better
 * in the UI than `5511912345678` — so every comparison (seeding's natural key, the duplicate
 * check `POST /{wabaId}/phone_numbers` performs, the digits webhooks carry) goes through
 * {@link phoneNumberDigits} instead of comparing the formatted strings.
 */

/** Everything but digits is formatting: `+55 11 91234-5678` and `5511912345678` are one number. */
export function phoneNumberDigits(value: string): string {
	return value.replaceAll(/\D/g, "");
}

/**
 * A display number for E.164 digits whaloc was handed without formatting — what
 * `POST /{wabaId}/phone_numbers` gets. Meta groups the digits per country
 * (`+1 631-555-5555`); whaloc does not guess at grouping rules it would get wrong, and keeps
 * the number unambiguous and never blank (SPEC §2.1).
 */
export function formatDisplayPhoneNumber(digits: string): string {
	return `+${digits}`;
}
