/**
 * Every timestamp whaloc stores is an ISO 8601 string in UTC (see the `Database` interface):
 * sortable as text, readable in a SQLite shell, and ready to serve over the control-plane
 * API. Webhook payloads convert to the Unix seconds Meta uses at emission time (SPEC §1.14).
 */
export function nowIso(): string {
	const now = new Date();

	return now.toISOString();
}
