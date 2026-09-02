import { expect } from "vitest";

/**
 * Test-support helpers shared by the Graph API specs.
 *
 * `Response#json()` and vitest's asymmetric matchers are both typed `any`, which the lint
 * rules reject the moment either lands in a variable or an object literal. Wrapping them once
 * here keeps every spec typed instead of sprinkling assertions through the assertions.
 */

/** Reads a JSON response body, narrowed by the caller to the shape it expects. */
export async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

/**
 * The status of a response, in one expression. A spec that only cares about the status —
 * "these three sends are 429, the fourth is 200" — reads better as a list of numbers than as a
 * list of two-line awaits.
 */
export async function statusOf(response: Response | Promise<Response>): Promise<number> {
	const settled = await response;

	return settled.status;
}

/** The path of an absolute URL, which is what `app.request()` takes. */
export function pathOf(url: string): string {
	const parsed = new URL(url);

	return parsed.pathname;
}

/** `expect.any(String)`, usable inside a typed object literal. */
export function anyString(): string {
	return expect.any(String) as string;
}

/** `expect.stringMatching(pattern)`, usable inside a typed object literal. */
export function stringMatching(pattern: RegExp | string): string {
	return expect.stringMatching(pattern) as string;
}

/** `expect.stringContaining(fragment)`, usable inside a typed object literal. */
export function stringContaining(fragment: string): string {
	return expect.stringContaining(fragment) as string;
}
