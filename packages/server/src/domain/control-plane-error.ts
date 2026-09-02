/**
 * The domain's error for control-plane operations (SPEC §8).
 *
 * The Graph surface answers with Meta's envelope through {@link GraphApiError}; the control
 * plane is whaloc's own API and answers with a plain `{error:{message,code?}}`. Keeping a
 * separate class means a service can say "unknown media id" without importing Hono or
 * pretending to be Meta.
 */
export interface ControlPlaneErrorOptions extends ErrorOptions {
	/** HTTP status the control-plane error handler answers with. */
	status?: number;
	/** Machine-readable hint for the UI, e.g. `unknown_media`. */
	code?: string;
}

export class ControlPlaneError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, options: ControlPlaneErrorOptions = {}) {
		super(message, options);
		this.name = "ControlPlaneError";
		this.status = options.status ?? 400;
		this.code = options.code;
	}
}

export function isControlPlaneError(error: unknown): error is ControlPlaneError {
	return error instanceof ControlPlaneError;
}

export function controlNotFound(message: string, code?: string): ControlPlaneError {
	return new ControlPlaneError(message, { status: 404, ...(code !== undefined && { code }) });
}

export function controlBadRequest(message: string, code?: string): ControlPlaneError {
	return new ControlPlaneError(message, { status: 400, ...(code !== undefined && { code }) });
}

export function controlConflict(message: string, code?: string): ControlPlaneError {
	return new ControlPlaneError(message, { status: 409, ...(code !== undefined && { code }) });
}
