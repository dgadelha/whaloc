/** Date, size and duration formatting, in the viewer's locale and time zone. */

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const clockWithSeconds = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dayWithYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function formatClock(iso: string): string {
	return clock.format(new Date(iso));
}

export function formatClockWithSeconds(iso: string): string {
	return clockWithSeconds.format(new Date(iso));
}

/** Local calendar day, used to group a conversation into day separators. */
export function dayKey(iso: string): string {
	const date = new Date(iso);

	return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatDayLabel(iso: string, now: Date = new Date()): string {
	const key = dayKey(iso);
	const yesterday = new Date(now);

	yesterday.setDate(now.getDate() - 1);

	if (key === dayKey(now.toISOString())) {
		return "Today";
	}

	if (key === dayKey(yesterday.toISOString())) {
		return "Yesterday";
	}

	const date = new Date(iso);

	return date.getFullYear() === now.getFullYear() ? day.format(date) : dayWithYear.format(date);
}

/** A timestamp for a list: the clock today, the day before that. */
export function formatListTime(iso: string, now: Date = new Date()): string {
	return dayKey(iso) === dayKey(now.toISOString()) ? formatClock(iso) : formatDayLabel(iso, now);
}

/** Absolute date and time, for a table column where "3 minutes ago" would hide the ordering. */
export function formatTimestamp(iso: string): string {
	const date = new Date(iso);

	return date.toLocaleString();
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;

	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}

	return `${unit === 0 ? String(value) : value.toFixed(1)} ${BYTE_UNITS[unit] ?? "B"}`;
}

export function formatDuration(ms: number | null): string {
	if (ms === null) {
		return "—";
	}

	return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
