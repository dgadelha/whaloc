import clsx from "clsx";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

/**
 * One segment of the breadcrumb: a button that opens a menu of the things it can point at, plus
 * a final action that creates the next one.
 *
 * Written by hand rather than pulled from a library. It is a button and a list of buttons; what
 * a menu package would add is a focus trap and a positioning engine, neither of which a segment
 * anchored under its own button in a fixed top bar needs. The keyboard contract is the WAI-ARIA
 * menu-button one: Enter/Space/ArrowDown open on the current item, arrows and Home/End move,
 * Escape closes and hands focus back, Tab or a click elsewhere dismisses.
 */

export interface ScopeMenuItem {
	id: string;
	label: string;
	/** The id, a number of numbers — whatever tells two similarly named entries apart. */
	hint?: string | undefined;
	/** A short status, shown only when it is worth interrupting for (a number that is not CONNECTED). */
	badge?: string | undefined;
}

export interface ScopeMenuProps {
	/** What the segment is, for screen readers: "WABA", "Phone number". */
	label: string;
	/** The text on the button; the placeholder when nothing is selected. */
	current: string;
	currentHint?: string | undefined;
	items: ScopeMenuItem[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	/** The trailing "Create WABA…" / "Add number…" entry. */
	action: { label: string; onSelect: () => void };
	/** Renders the button muted, for a segment that has nothing selected yet. */
	isEmpty?: boolean;
}

export function ScopeMenu(props: ScopeMenuProps) {
	const menuId = useId();
	const [isOpen, setIsOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
	// The scope entries plus the trailing action, which is the last stop of the same roving focus.
	const count = props.items.length + 1;

	const close = (shouldReturnFocus: boolean): void => {
		setIsOpen(false);

		if (shouldReturnFocus) {
			buttonRef.current?.focus();
		}
	};

	const open = (index: number): void => {
		setActiveIndex(index);
		setIsOpen(true);
	};

	useEffect(() => {
		if (!isOpen) {
			return;
		}

		itemRefs.current[activeIndex]?.focus();
	}, [isOpen, activeIndex]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}

		const onPointerDown = (event: Event): void => {
			const target = event.target;

			if (target instanceof Node && buttonRef.current?.parentElement?.contains(target) === true) {
				return;
			}

			setIsOpen(false);
		};

		globalThis.document.addEventListener("pointerdown", onPointerDown);

		return () => {
			globalThis.document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [isOpen]);

	const selectedIndex = Math.max(
		0,
		props.items.findIndex(item => item.id === props.selectedId),
	);

	const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
		if (["ArrowDown", "Enter", " "].includes(event.key)) {
			event.preventDefault();
			open(selectedIndex);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			open(count - 1);
		}
	};

	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		switch (event.key) {
			case "ArrowDown": {
				event.preventDefault();
				setActiveIndex(current => (current + 1) % count);
				break;
			}

			case "ArrowUp": {
				event.preventDefault();
				setActiveIndex(current => (current - 1 + count) % count);
				break;
			}

			case "Home": {
				event.preventDefault();
				setActiveIndex(0);
				break;
			}

			case "End": {
				event.preventDefault();
				setActiveIndex(count - 1);
				break;
			}

			case "Escape": {
				event.preventDefault();
				close(true);
				break;
			}

			case "Tab": {
				close(false);
				break;
			}

			default: {
				break;
			}
		}
	};

	return (
		<div className="scope">
			<button
				type="button"
				ref={buttonRef}
				className={clsx("scope__button", props.isEmpty === true && "scope__button--empty")}
				aria-label={props.label}
				aria-haspopup="menu"
				aria-expanded={isOpen}
				aria-controls={isOpen ? menuId : undefined}
				title={props.currentHint === undefined ? props.current : `${props.current} · ${props.currentHint}`}
				onClick={() => {
					if (isOpen) {
						close(false);
					} else {
						open(selectedIndex);
					}
				}}
				onKeyDown={onButtonKeyDown}
			>
				<span className="scope__name">{props.current}</span>
				<span className="scope__caret" aria-hidden="true">
					▾
				</span>
			</button>

			{isOpen && (
				<div className="scope__menu" role="menu" id={menuId} aria-label={props.label} onKeyDown={onMenuKeyDown}>
					{props.items.map((item, index) => (
						<button
							key={item.id}
							type="button"
							role="menuitemradio"
							aria-checked={item.id === props.selectedId}
							tabIndex={-1}
							ref={element => {
								itemRefs.current[index] = element;
							}}
							className={clsx("scope__item", item.id === props.selectedId && "is-selected")}
							onClick={() => {
								// Focus goes back to the segment rather than to the body: the button
								// is still there after the navigation, and it now names what was picked.
								close(true);
								props.onSelect(item.id);
							}}
						>
							<span className="scope__item-label">{item.label}</span>
							{item.badge !== undefined && <span className="badge badge--warn">{item.badge}</span>}
							{item.hint !== undefined && <span className="scope__item-hint">{item.hint}</span>}
						</button>
					))}

					<button
						type="button"
						role="menuitem"
						tabIndex={-1}
						ref={element => {
							itemRefs.current[props.items.length] = element;
						}}
						className="scope__item scope__item--action"
						onClick={() => {
							close(true);
							props.action.onSelect();
						}}
					>
						{props.action.label}
					</button>
				</div>
			)}
		</div>
	);
}
