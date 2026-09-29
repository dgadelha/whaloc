/**
 * The version whaloc stamps on a state snapshot (SPEC §5).
 *
 * The release tag is the only source of truth: the Docker build passes it in as the
 * `WHALOC_VERSION` build argument, which the image carries as an environment variable. Nothing in
 * the repository is bumped for a release, so there is nothing to forget — the workspace
 * `package.json` versions stay `0.0.0`, which is fine for packages that are never published. A
 * run from source is `0.0.0-dev`. Nothing depends on it being right: an import is gated on the
 * snapshot's *schema* version, not on this.
 */
export function whalocVersion(env: Readonly<Record<string, string | undefined>>): string {
	const version = env["WHALOC_VERSION"]?.trim();

	return version === undefined || version === "" ? "0.0.0-dev" : version;
}

export const WHALOC_VERSION = whalocVersion(process.env);
