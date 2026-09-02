import { useEffect, type ReactNode } from "react";

export interface DialogProps {
	title: string;
	subtitle?: string;
	onClose: () => void;
	children: ReactNode;
	footer?: ReactNode;
}

/**
 * A modal, plain enough to test: a backdrop that closes on click or Escape, and a panel that
 * does not. `<dialog>` is deliberately not used — `showModal` is unimplemented in jsdom, and
 * the UI is small enough that the manual version is shorter than the shim.
 */
export function Dialog(props: DialogProps) {
	const { onClose } = props;

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
			<div className="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
				<header className="dialog__header">
					<div>
						<h2>{props.title}</h2>
						{props.subtitle !== undefined && <p className="muted">{props.subtitle}</p>}
					</div>
					<button type="button" className="button button--ghost button--icon" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>
				{props.children}
				{props.footer !== undefined && <footer className="dialog__actions">{props.footer}</footer>}
			</div>
		</div>
	);
}
