import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export interface DialogProps {
	title: string;
	subtitle?: string;
	onClose: () => void;
	children: ReactNode;
	footer?: ReactNode;
}

const FOCUSABLE = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type=hidden])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableIn(panel: HTMLElement): HTMLElement[] {
	return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * A modal, plain enough to test: a backdrop that closes on click or Escape, and a panel that
 * does not. `<dialog>` is deliberately not used — `showModal` is unimplemented in jsdom, and
 * the UI is small enough that the manual version is shorter than the shim.
 *
 * What `showModal` would have given for free is done by hand: focus moves into the panel on
 * open, Tab and Shift+Tab cycle inside it, and closing hands focus back to whatever opened it.
 */
export function Dialog(props: DialogProps) {
	const { onClose } = props;
	const panelRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	// Read during the first render, not in an effect: by the time effects run, an `autoFocus`
	// child has already taken focus and the opener is no longer `activeElement`.
	const [opener] = useState(() => document.activeElement);

	useEffect(() => {
		const panel = panelRef.current;

		if (panel !== null && !panel.contains(document.activeElement)) {
			// Close leads every header, so landing on it first would cost a form dialog a Tab
			// before its first field; it only takes focus when nothing else can.
			const focusable = focusableIn(panel);

			(focusable.find(element => element !== closeRef.current) ?? focusable[0] ?? panel).focus();
		}

		return () => {
			if (!(opener instanceof HTMLElement) || !opener.isConnected) {
				return;
			}

			if (!opener.matches(":disabled")) {
				opener.focus();

				return;
			}

			// A caller can disable the opener in the same update that closes the dialog — a list
			// row closes it and starts its reply at once — and a disabled element ignores focus().
			// Focus waits for the opener to come back, unless the user has moved it meanwhile.
			const observer = new MutationObserver(() => {
				if (opener.matches(":disabled")) {
					return;
				}

				observer.disconnect();

				if (opener.isConnected && (document.activeElement === null || document.activeElement === document.body)) {
					opener.focus();
				}
			});

			observer.observe(opener, { attributes: true, attributeFilter: ["disabled"] });
		};
	}, [opener]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				onClose();
			}
		};

		globalThis.addEventListener("keydown", onKeyDown);

		return () => {
			globalThis.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose]);

	const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Tab") {
			return;
		}

		const focusable = focusableIn(event.currentTarget);
		const first = focusable[0];
		const last = focusable.at(-1);

		if (first === undefined || last === undefined) {
			event.preventDefault();

			return;
		}

		const active = document.activeElement;

		if (event.shiftKey && (active === first || active === event.currentTarget)) {
			event.preventDefault();
			last.focus();
		} else if (active === last && !event.shiftKey) {
			event.preventDefault();
			first.focus();
		}
	};

	return (
		<div
			className="dialog-backdrop"
			role="presentation"
			onClick={event => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div
				ref={panelRef}
				className="dialog"
				role="dialog"
				aria-modal="true"
				aria-label={props.title}
				tabIndex={-1}
				onKeyDown={trapTab}
			>
				<header className="dialog__header">
					<div>
						<h2>{props.title}</h2>
						{props.subtitle !== undefined && <p className="muted">{props.subtitle}</p>}
					</div>
					<button
						ref={closeRef}
						type="button"
						className="button button--ghost button--icon"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</header>
				{props.children}
				{props.footer !== undefined && <footer className="dialog__actions">{props.footer}</footer>}
			</div>
		</div>
	);
}
