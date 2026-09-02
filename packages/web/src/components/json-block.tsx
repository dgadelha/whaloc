import clsx from "clsx";
import { pretty } from "../lib/json.ts";

export interface JsonBlockProps {
	value?: unknown;
	/** Already-serialized JSON, rendered verbatim — callers wanting it re-indented pass it through `prettyJsonText` first. */
	text?: string;
	className?: string;
}

export function JsonBlock(props: JsonBlockProps) {
	return <pre className={clsx("json mono", props.className)}>{props.text ?? pretty(props.value)}</pre>;
}
