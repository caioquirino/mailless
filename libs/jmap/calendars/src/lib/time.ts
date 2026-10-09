/*
 * The times of JSCalendar (RFC 8984): a date and time as a clock on a wall
 * shows them, a time zone that says which wall, and a duration.
 */

/** A LocalDateTime: `2026-10-09T14:00:00`, with no zone and no offset. */
export const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

const DURATION =
  /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.\d+)?S)?)?$/;

/** How long a duration such as `PT1H30M` is, or null when it is not one. */
export function durationMillis(duration: string): number | null {
  const found = DURATION.exec(duration);
  if (!found || duration === 'P' || duration.endsWith('T')) return null;
  const [weeks, days, hours, minutes, seconds] = found
    .slice(1)
    .map((part) => Number(part ?? 0));
  return (
    ((((weeks ?? 0) * 7 + (days ?? 0)) * 24 + (hours ?? 0)) * 60 +
      (minutes ?? 0)) *
      60_000 +
    (seconds ?? 0) * 1000
  );
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(zone, format);
  }
  return format;
}

/** Whether a name is a time zone this server knows (IANA: `Europe/Lisbon`). */
export function isTimeZone(zone: string): boolean {
  try {
    formatIn(zone);
    return true;
  } catch {
    return false;
  }
}

/** How far ahead of UTC the clocks of a zone are at an instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatIn(zone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const shown = Date.UTC(
    parts['year'] ?? 0,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0,
  );
  return shown - instant;
}

/**
 * The instant at which the clocks of a zone show a local date and time, in
 * milliseconds since 1970. With no zone the time floats, and is taken as UTC.
 */
export function zonedToUtc(local: string, zone: string | null): number {
  const asUtc = Date.parse(`${local}Z`);
  if (zone === null || Number.isNaN(asUtc)) return asUtc;
  // The offset is asked for twice: around a change of clocks the first guess is an hour out.
  const guess = asUtc - offsetAt(asUtc, zone);
  return asUtc - offsetAt(guess, zone);
}

/** What the clocks of a zone show at an instant, as a local date and time. */
export function utcToZoned(instant: number, zone: string): string {
  return new Date(instant + offsetAt(instant, zone)).toISOString().slice(0, 19);
}
