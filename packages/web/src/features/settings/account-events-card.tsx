import {
	ACCOUNT_RESTRICTION_TYPES,
	ACCOUNT_UPDATE_EVENTS,
	type AccountRestrictionType,
	type AccountUpdateEvent,
	type WabaState,
} from "@whaloc/shared";
import { useState } from "react";
import { api } from "../../api/endpoints.ts";
import { useAction, useToasts } from "../../store/store.tsx";

/**
 * The two **account-level webhooks** (SPEC §3, §5), triggered per WABA the way the quality one is
 * triggered per number.
 *
 * They are emissions and nothing else: pressing Send delivers Meta's payload and changes no
 * whaloc state, which the copy says out loud so nobody goes looking for a "restricted" flag
 * afterwards. `entry.id` is this account, so the card lives on this account's section.
 */
export interface AccountEventsCardProps {
	waba: WabaState;
}

/** Only `ACCOUNT_RESTRICTION` carries `restriction_info`; the other events have nothing to shape. */
const RESTRICTION_EVENT: AccountUpdateEvent = "ACCOUNT_RESTRICTION";

export function AccountEventsCard(props: AccountEventsCardProps) {
	const { waba } = props;
	const toasts = useToasts();
	const run = useAction();
	const [event, setEvent] = useState<AccountUpdateEvent>("VERIFIED_ACCOUNT");
	const [phoneNumberId, setPhoneNumberId] = useState("");
	const [restrictionType, setRestrictionType] = useState<AccountRestrictionType>("RESTRICTED_ADD_PHONE_NUMBER_ACTION");
	const [expiration, setExpiration] = useState("");
	const [maxDaily, setMaxDaily] = useState("1000");
	const [maxNumbers, setMaxNumbers] = useState("25");

	const sendAccountUpdate = (): void => {
		run(async () => {
			await api.sendAccountUpdate({
				wabaId: waba.id,
				event,
				...(phoneNumberId !== "" && { phoneNumberId }),
				...(event === RESTRICTION_EVENT && {
					restrictionInfo: [{ restrictionType, ...(expiration.trim() !== "" && { expiration: expiration.trim() }) }],
				}),
			});
			toasts.info(`account_update ${event} sent`);
		});
	};

	const sendCapability = (): void => {
		const maxDailyConversationPerPhone = Number(maxDaily);
		const maxPhoneNumbersPerBusiness = Number(maxNumbers);

		if (!Number.isSafeInteger(maxDailyConversationPerPhone) || !Number.isSafeInteger(maxPhoneNumbersPerBusiness)) {
			toasts.info("Both capability limits have to be whole numbers");

			return;
		}

		run(async () => {
			await api.sendBusinessCapabilityUpdate({
				wabaId: waba.id,
				maxDailyConversationPerPhone,
				maxPhoneNumbersPerBusiness,
			});
			toasts.info("business_capability_update sent");
		});
	};

	return (
		<div className="card stack">
			<div className="row row--wrap">
				<h4>Account webhooks</h4>
				<span className="spacer" />
				<span className="faint">events only — nothing here changes whaloc&apos;s state</span>
			</div>

			<div className="settings__grid">
				<label className="field">
					<span className="field__label">account_update event</span>
					<select
						className="select"
						aria-label={`account_update event for ${waba.name}`}
						value={event}
						onChange={changed => {
							setEvent(changed.target.value as AccountUpdateEvent);
						}}
					>
						{ACCOUNT_UPDATE_EVENTS.map(candidate => (
							<option key={candidate} value={candidate}>
								{candidate}
							</option>
						))}
					</select>
				</label>

				<label className="field">
					<span className="field__label">phone_number (optional)</span>
					<select
						className="select"
						aria-label={`account_update phone number for ${waba.name}`}
						value={phoneNumberId}
						onChange={changed => {
							setPhoneNumberId(changed.target.value);
						}}
					>
						<option value="">none</option>
						{waba.phoneNumbers.map(phoneNumber => (
							<option key={phoneNumber.id} value={phoneNumber.id}>
								{phoneNumber.displayPhoneNumber}
							</option>
						))}
					</select>
				</label>

				{event === RESTRICTION_EVENT && (
					<>
						<label className="field">
							<span className="field__label">restriction_type</span>
							<select
								className="select"
								value={restrictionType}
								onChange={changed => {
									setRestrictionType(changed.target.value as AccountRestrictionType);
								}}
							>
								{ACCOUNT_RESTRICTION_TYPES.map(candidate => (
									<option key={candidate} value={candidate}>
										{candidate}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span className="field__label">expiration (optional)</span>
							<input
								className="input"
								placeholder="2026-12-31"
								value={expiration}
								onChange={changed => {
									setExpiration(changed.target.value);
								}}
							/>
						</label>
					</>
				)}
			</div>

			<div className="row row--wrap">
				<span className="spacer" />
				<button type="button" className="button" onClick={sendAccountUpdate}>
					Send account_update
				</button>
			</div>

			<hr className="divider" />

			<div className="settings__grid">
				<label className="field">
					<span className="field__label">max_daily_conversation_per_phone</span>
					<input
						className="input"
						inputMode="numeric"
						value={maxDaily}
						onChange={changed => {
							setMaxDaily(changed.target.value);
						}}
					/>
				</label>
				<label className="field">
					<span className="field__label">max_phone_numbers_per_business</span>
					<input
						className="input"
						inputMode="numeric"
						value={maxNumbers}
						onChange={changed => {
							setMaxNumbers(changed.target.value);
						}}
					/>
				</label>
			</div>

			<div className="row row--wrap">
				<span className="spacer" />
				<button type="button" className="button" onClick={sendCapability}>
					Send business_capability_update
				</button>
			</div>
		</div>
	);
}
