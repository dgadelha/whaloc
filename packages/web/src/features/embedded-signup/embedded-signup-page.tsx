import {
	LOGIN_RESPONSE_TYPE,
	SIGNUP_CANCEL_STEPS,
	type SignupCancelStep,
	type SignupChoice,
	type SessionInfoVersion,
	type SignupCompleteRequest,
} from "@whaloc/shared";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { describeError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { originOf, postToOpener } from "./opener.ts";

/**
 * The Embedded Signup dialog `sdk.js` opens (SPEC §2.24), in the steps Meta's walks through:
 * the account, then the number, then a review that finishes. Each finish posts Meta's session
 * event and whaloc's code message to the opener, then closes; Cancel and Simulate error post
 * the two events that end the dialog without a code.
 *
 * It runs outside the control plane's store: a popup has no use for the socket or the state.
 */

type Step = "account" | "phone" | "review";

const STEPS: readonly { id: Step; label: string }[] = [
	{ id: "account", label: "Business account" },
	{ id: "phone", label: "Phone number" },
	{ id: "review", label: "Review" },
];

const NEW = "new";
const NONE = "none";

/** `extras.version` as `FB.login` forwarded it: v5 asks for its own finish events. */
function sessionInfoVersionOf(extras: string | null): SessionInfoVersion {
	if (extras === null) {
		return "v4";
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(extras);
	} catch {
		return "v4";
	}

	return typeof parsed === "object" && parsed !== null && "version" in parsed && parsed.version === "v5" ? "v5" : "v4";
}

type Load = { phase: "loading" } | { phase: "failed"; message: string } | { phase: "ready"; choices: SignupChoice[] };

function Refusal(props: { message: string }) {
	return (
		<main className="signup">
			<section className="card stack">
				<h1>Embedded Signup</h1>
				<p className="field__error" role="alert">
					{props.message}
				</p>
			</section>
		</main>
	);
}

export function EmbeddedSignupPage() {
	const [params] = useSearchParams();
	const appId = params.get("app_id");
	const origin = originOf(params.get("origin"));
	const sessionInfoVersion = sessionInfoVersionOf(params.get("extras"));
	const [load, setLoad] = useState<Load>({ phase: "loading" });

	useEffect(() => {
		if (appId === null || origin === null) {
			return;
		}

		const controller = new AbortController();

		void (async () => {
			try {
				setLoad({ phase: "ready", choices: await api.signupChoices(appId, { signal: controller.signal }) });
			} catch (error) {
				if (!controller.signal.aborted) {
					setLoad({ phase: "failed", message: describeError(error) });
				}
			}
		})();

		return () => {
			controller.abort();
		};
	}, [appId, origin]);

	if (appId === null) {
		return <Refusal message="App ID (none) is not this whaloc's app." />;
	}

	if (origin === null) {
		return <Refusal message="The dialog has no page to answer to: open it through FB.login." />;
	}

	if (load.phase === "loading") {
		return (
			<div className="boot">
				<p>Loading…</p>
			</div>
		);
	}

	if (load.phase === "failed") {
		return <Refusal message={load.message} />;
	}

	return <SignupFlow appId={appId} origin={origin} sessionInfoVersion={sessionInfoVersion} choices={load.choices} />;
}

interface SignupFlowProps {
	appId: string;
	origin: string;
	sessionInfoVersion: SessionInfoVersion;
	choices: SignupChoice[];
}

function SignupFlow(props: SignupFlowProps) {
	const { appId, origin, sessionInfoVersion, choices } = props;
	const [step, setStep] = useState<Step>("account");
	const [waba, setWaba] = useState(choices[0]?.waba.id ?? NEW);
	const [wabaName, setWabaName] = useState("");
	const [phoneNumber, setPhoneNumber] = useState(choices[0]?.phoneNumbers[0]?.id ?? NEW);
	const [digits, setDigits] = useState("");
	const [verifiedName, setVerifiedName] = useState("");
	const [coexistence, setCoexistence] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	// One request at a time, Finish's or Simulate error's, and nothing after the dialog has ended.
	const [busy, setBusy] = useState(false);
	const [closedWith, setClosedWith] = useState<string | null>(null);
	const ended = useRef(false);
	// Follows the step the flow is on until it is picked by hand.
	const [pickedCancelStep, setPickedCancelStep] = useState<string | null>(null);

	if (closedWith !== null) {
		return (
			<main className="signup">
				<section className="card stack">
					<h1>Embedded Signup</h1>
					<p role="status">{closedWith}</p>
				</section>
			</main>
		);
	}

	const chosenWaba = choices.find(choice => choice.waba.id === waba);
	const numbers = chosenWaba?.phoneNumbers ?? [];
	const chosenNumber = numbers.find(number => number.id === phoneNumber);
	const isNewNumber = phoneNumber === NEW;

	const finishWith = (message: string, messages: readonly unknown[]): void => {
		if (ended.current) {
			return;
		}

		ended.current = true;
		setClosedWith(message);
		postToOpener(origin, messages);
	};

	const toPhoneStep = (): void => {
		if (waba === NEW && wabaName.trim() === "") {
			setFailure("A new WABA needs a name.");

			return;
		}

		if (phoneNumber !== NEW && phoneNumber !== NONE && chosenNumber === undefined) {
			setPhoneNumber(numbers[0]?.id ?? NEW);
		}

		setFailure(null);
		setStep("phone");
	};

	const toReviewStep = (): void => {
		if (isNewNumber && (digits.trim() === "" || verifiedName.trim() === "")) {
			setFailure("A new phone number needs the number and a display name.");

			return;
		}

		setFailure(null);
		setStep("review");
	};

	const request = (): SignupCompleteRequest => {
		return {
			appId,
			sessionInfoVersion,
			waba: waba === NEW ? { kind: "new", name: wabaName.trim() } : { kind: "existing", id: waba },
			phoneNumber: isNewNumber
				? { kind: "new", phoneNumber: digits.trim(), verifiedName: verifiedName.trim(), coexistence }
				: phoneNumber === NONE
					? { kind: "none" }
					: { kind: "existing", id: phoneNumber },
		};
	};

	const finish = (): void => {
		setFailure(null);
		setBusy(true);

		void (async () => {
			try {
				const { code, sessionEvent } = await api.completeSignup(request());

				finishWith("Account connected. You can close this window.", [
					sessionEvent,
					{ type: LOGIN_RESPONSE_TYPE, code },
				]);
			} catch (error) {
				setFailure(describeError(error));
			} finally {
				setBusy(false);
			}
		})();
	};

	const defaultCancelStep: SignupCancelStep =
		step === "account"
			? waba === NEW
				? "ASSET_CREATION"
				: "ASSET_SELECTION"
			: isNewNumber && coexistence
				? "WHATSAPP_BUSINESS_APP_ONBOARDING_PHONE_CREATION"
				: "PHONE_NUMBER_SETUP";

	return (
		<main className="signup">
			<section className="card stack" aria-labelledby="signup-title">
				<header className="stack">
					<h1 id="signup-title">Connect a WhatsApp Business account</h1>
					<p className="muted">
						For app <code>{appId}</code>, answering <code>{origin}</code>
					</p>
					<ol className="signup__steps">
						{STEPS.map((item, index) => (
							<li
								key={item.id}
								className={clsx("signup__step", item.id === step && "is-current")}
								aria-current={item.id === step ? "step" : undefined}
							>
								<span className="signup__step-number">{index + 1}</span>
								{item.label}
							</li>
						))}
					</ol>
				</header>

				{step === "account" && (
					<fieldset className="signup__options">
						<legend className="section-label">Choose a WhatsApp Business account</legend>
						{choices.map(choice => (
							<Option
								key={choice.waba.id}
								name="waba"
								value={choice.waba.id}
								selected={waba}
								onSelect={setWaba}
								label={choice.waba.name}
								hint={`ID ${choice.waba.id} · ${String(choice.phoneNumbers.length)} phone number(s)`}
							/>
						))}
						<Option name="waba" value={NEW} selected={waba} onSelect={setWaba} label="Create a new WABA" />
						{waba === NEW && (
							<label className="field signup__nested">
								<span className="field__label">Account name</span>
								<input
									className="input"
									aria-label="New WABA name"
									placeholder="business name"
									value={wabaName}
									onChange={changed => {
										setWabaName(changed.target.value);
									}}
								/>
							</label>
						)}
					</fieldset>
				)}

				{step === "phone" && (
					<fieldset className="signup__options">
						<legend className="section-label">Choose a phone number</legend>
						{numbers.map(number => (
							<Option
								key={number.id}
								name="phone_number"
								value={number.id}
								selected={phoneNumber}
								onSelect={setPhoneNumber}
								label={number.displayPhoneNumber}
								hint={`${number.verifiedName} · ${number.status}`}
							/>
						))}
						<Option
							name="phone_number"
							value={NEW}
							selected={phoneNumber}
							onSelect={setPhoneNumber}
							label="Add a new phone number"
							hint="Verified in this dialog: the app registers it afterwards."
						/>
						{isNewNumber && (
							<div className="stack signup__nested">
								<label className="field">
									<span className="field__label">Phone number, with country code</span>
									<input
										className="input"
										aria-label="New phone number"
										placeholder="+1 631 555 0100"
										value={digits}
										onChange={changed => {
											setDigits(changed.target.value);
										}}
									/>
								</label>
								<label className="field">
									<span className="field__label">Display name</span>
									<input
										className="input"
										aria-label="Display name"
										placeholder="business name"
										value={verifiedName}
										onChange={changed => {
											setVerifiedName(changed.target.value);
										}}
									/>
								</label>
								<label className="checkbox">
									<input
										type="checkbox"
										checked={coexistence}
										onChange={changed => {
											setCoexistence(changed.target.checked);
										}}
									/>
									Already on the WhatsApp Business app (coexistence)
								</label>
							</div>
						)}
						<Option
							name="phone_number"
							value={NONE}
							selected={phoneNumber}
							onSelect={setPhoneNumber}
							label="Continue without a phone number"
							hint="Only the WABA is shared; a number can be added later."
						/>
					</fieldset>
				)}

				{step === "review" && (
					<dl className="settings__list">
						<div>
							<dt>Business account</dt>
							<dd>{waba === NEW ? `${wabaName.trim()} (new)` : (chosenWaba?.waba.name ?? waba)}</dd>
						</div>
						<div>
							<dt>Phone number</dt>
							<dd>
								{isNewNumber
									? `${digits.trim()} · ${verifiedName.trim()} (new${coexistence ? ", coexistence" : ""})`
									: phoneNumber === NONE
										? "None"
										: (chosenNumber?.displayPhoneNumber ?? phoneNumber)}
							</dd>
						</div>
					</dl>
				)}

				{failure !== null && (
					<p className="field__error" role="alert">
						{failure}
					</p>
				)}

				<footer className="row">
					{step !== "account" && (
						<button
							type="button"
							className="button"
							disabled={busy}
							onClick={() => {
								setFailure(null);
								setStep(step === "review" ? "phone" : "account");
							}}
						>
							Back
						</button>
					)}
					<span className="spacer" />
					{step === "account" && (
						<button type="button" className="button button--primary" onClick={toPhoneStep}>
							Next
						</button>
					)}
					{step === "phone" && (
						<button type="button" className="button button--primary" onClick={toReviewStep}>
							Next
						</button>
					)}
					{step === "review" && (
						<button type="button" className="button button--primary" disabled={busy} onClick={finish}>
							{busy ? "finishing…" : "Finish"}
						</button>
					)}
				</footer>
			</section>

			<ExitPanel
				appId={appId}
				isBusy={busy}
				onBusyChange={setBusy}
				cancelStep={pickedCancelStep ?? defaultCancelStep}
				onCancelStepChange={setPickedCancelStep}
				onExit={finishWith}
			/>
		</main>
	);
}

interface OptionProps {
	name: string;
	value: string;
	selected: string;
	onSelect: (value: string) => void;
	label: string;
	hint?: string;
}

function Option(props: OptionProps) {
	return (
		<label className={clsx("signup__option", props.value === props.selected && "is-selected")}>
			<input
				type="radio"
				name={props.name}
				value={props.value}
				checked={props.value === props.selected}
				onChange={() => {
					props.onSelect(props.value);
				}}
			/>
			<span className="stack signup__option-text">
				<span>{props.label}</span>
				{props.hint !== undefined && <span className="field__hint">{props.hint}</span>}
			</span>
		</label>
	);
}

interface ExitPanelProps {
	appId: string;
	isBusy: boolean;
	onBusyChange: (isBusy: boolean) => void;
	cancelStep: string;
	onCancelStepChange: (step: string) => void;
	onExit: (message: string, messages: readonly unknown[]) => void;
}

/** The two ways out that produce no code, folded away from the flow they would interrupt. */
function ExitPanel(props: ExitPanelProps) {
	const [errorCode, setErrorCode] = useState("1");
	const [errorMessage, setErrorMessage] = useState("An unexpected error occurred");
	const [failure, setFailure] = useState<string | null>(null);

	const cancel = (): void => {
		props.onExit("Signup cancelled.", [
			{ data: { current_step: props.cancelStep }, type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" },
		]);
	};

	const simulateError = (): void => {
		setFailure(null);
		props.onBusyChange(true);

		void (async () => {
			try {
				const session = await api.signupErrorSession(props.appId);

				props.onExit("Signup failed.", [
					{
						data: {
							error_message: errorMessage,
							error_code: errorCode,
							session_id: session.sessionId,
							timestamp: session.timestamp,
						},
						type: "WA_EMBEDDED_SIGNUP",
						event: "ERROR",
					},
				]);
			} catch (error) {
				setFailure(describeError(error));
			} finally {
				props.onBusyChange(false);
			}
		})();
	};

	return (
		<details className="card signup__exit">
			<summary className="section-label">Leave without finishing</summary>
			<div className="stack">
				<div className="row row--wrap signup__exit-row">
					<label className="field spacer">
						<span className="field__label">Cancel at step</span>
						<select
							className="select"
							aria-label="Cancel at step"
							value={props.cancelStep}
							onChange={changed => {
								props.onCancelStepChange(changed.target.value);
							}}
						>
							{SIGNUP_CANCEL_STEPS.map(value => (
								<option key={value}>{value}</option>
							))}
						</select>
					</label>
					<button type="button" className="button" disabled={props.isBusy} onClick={cancel}>
						Cancel
					</button>
				</div>
				<div className="row row--wrap signup__exit-row">
					<label className="field">
						<span className="field__label">Error code</span>
						<input
							className="input settings__input--narrow"
							aria-label="Error code"
							value={errorCode}
							onChange={changed => {
								setErrorCode(changed.target.value);
							}}
						/>
					</label>
					<label className="field spacer">
						<span className="field__label">Error message</span>
						<input
							className="input"
							aria-label="Error message"
							value={errorMessage}
							onChange={changed => {
								setErrorMessage(changed.target.value);
							}}
						/>
					</label>
					<button type="button" className="button button--danger" disabled={props.isBusy} onClick={simulateError}>
						Simulate error
					</button>
				</div>
				{failure !== null && (
					<p className="field__error" role="alert">
						{failure}
					</p>
				)}
			</div>
		</details>
	);
}
