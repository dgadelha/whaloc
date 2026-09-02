import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/clipboard.ts";

export interface CopyButtonProps {
	value: string;
	label?: string;
	className?: string;
}

/**
 * Copies a value to the clipboard and says so for a moment. Ids are the reason this exists:
 * a `GRAPH_API_BASE_URL` call needs the phone number id, and retyping 15 digits from a screen
 * is how a dev tool loses an afternoon.
 */
export function CopyButton(props: CopyButtonProps) {
	const [copied, setCopied] = useState(false);
	// One timer at a time: a re-click restarts the confirmation instead of letting the first
	// click's timer cut the second one short.
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		return () => {
			clearTimeout(timer.current);
		};
	}, []);

	return (
		<button
			type="button"
			className={clsx("button button--ghost button--sm", props.className)}
			title={`Copy ${props.label ?? "to clipboard"}`}
			aria-label={`Copy ${props.label ?? props.value}`}
			onClick={() => {
				void (async () => {
					setCopied((await copyToClipboard(props.value)) === "copied");
					clearTimeout(timer.current);
					timer.current = setTimeout(() => {
						setCopied(false);
					}, 1200);
				})();
			}}
		>
			{copied ? "copied" : "copy"}
		</button>
	);
}
