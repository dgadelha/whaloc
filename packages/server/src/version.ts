/**
 * The version whaloc stamps on a state snapshot (SPEC §5).
 *
 * A constant rather than a read of `package.json`: the emitted `dist/` sits at a different
 * depth than the sources, the file is not part of the build output's public surface, and
 * whaloc's rule that nothing outside `storage/` touches the filesystem is worth more than an
 * automatically synced string. Keep it in step with the workspace version when one is cut —
 * nothing depends on it being right, since an import is gated on the snapshot's *schema*
 * version, not on this.
 */
export const WHALOC_VERSION = "0.0.0";
