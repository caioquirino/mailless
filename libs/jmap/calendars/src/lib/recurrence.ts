import { durationMillis, LOCAL_DATE_TIME, zonedToUtc } from './time.js';

/*
 * Events that repeat (RFC 8984 §4.3). A rule says when: every so many days,
 * weeks, months or years, on which days of them, until when or how often.
 * What it comes to is worked out on the clock of the event's own wall, so
 * that a meeting at nine stays at nine when the clocks change, and each
 * occurrence is then placed in the world's time.
 *
 * What is understood: `frequency` from daily to yearly, `interval`, `count`,
 * `until`, `byDay` (with `nthOfPeriod` in a month or a year), `byMonthDay`,
 * `byMonth` and `firstDayOfWeek`. A rule that asks for more (by the hour, by
 * week number, by position in a set) repeats as far as it is understood.
 */

/** A date and time on a wall, taken apart. Months count from 1. */
interface Wall {
  year: number;
  month: number;
  day: number;
  time: string;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

function wall(local: string): Wall {
  return {
    year: Number(local.slice(0, 4)),
    month: Number(local.slice(5, 7)),
    day: Number(local.slice(8, 10)),
    time: local.slice(11),
  };
}

const local = (year: number, month: number, day: number, time: string) =>
  `${pad(year, 4)}-${pad(month)}-${pad(day)}T${time}`;

/** Days since 1970 of a date, and back: for stepping by days and weeks. */
const dayNumber = (year: number, month: number, day: number) =>
  Math.round(Date.UTC(year, month - 1, day) / 86_400_000);

function fromDayNumber(days: number): {
  year: number;
  month: number;
  day: number;
} {
  const date = new Date(days * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

const daysIn = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
/** The day of the week of a day number: 0 for Sunday. */
const weekdayOf = (days: number) => (((days + 4) % 7) + 7) % 7;

interface NDay {
  day: number;
  nth: number | null;
}

interface Rule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  count: number | null;
  until: string | null;
  byDay: NDay[] | null;
  byMonthDay: number[] | null;
  byMonth: number[] | null;
  firstDay: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wholeNumbers = (value: unknown): number[] | null =>
  Array.isArray(value) && value.length > 0
    ? value.map(Number).filter((each) => Number.isInteger(each))
    : null;

/** A rule as it is understood here, or null for one that says nothing usable. */
function readRule(given: unknown): Rule | null {
  if (!isObject(given)) return null;
  const frequency = given['frequency'];
  if (
    frequency !== 'daily' &&
    frequency !== 'weekly' &&
    frequency !== 'monthly' &&
    frequency !== 'yearly'
  ) {
    return null;
  }
  const interval = Number(given['interval'] ?? 1);
  const count = given['count'] === undefined ? null : Number(given['count']);
  const until = given['until'];
  const byDay = Array.isArray(given['byDay'])
    ? given['byDay'].flatMap((each): NDay[] => {
        if (!isObject(each)) return [];
        const day = WEEKDAYS.indexOf(String(each['day']));
        const nth = each['nthOfPeriod'];
        return day < 0
          ? []
          : [{ day, nth: Number.isInteger(nth) ? (nth as number) : null }];
      })
    : null;
  const firstDay = WEEKDAYS.indexOf(String(given['firstDayOfWeek'] ?? 'mo'));
  return {
    frequency,
    interval: Number.isInteger(interval) && interval > 0 ? interval : 1,
    count:
      count !== null && Number.isInteger(count) && count > 0 ? count : null,
    until:
      typeof until === 'string' && LOCAL_DATE_TIME.test(until) ? until : null,
    byDay: byDay && byDay.length > 0 ? byDay : null,
    byMonthDay: wholeNumbers(given['byMonthDay']),
    byMonth: wholeNumbers(given['byMonth']),
    firstDay: firstDay < 0 ? 1 : firstDay,
  };
}

/** The rules of an event: `recurrenceRules` (RFC 8984), or the one `recurrenceRule` of its successor. */
export function rulesOf(event: Record<string, unknown>): unknown[] {
  const many = event['recurrenceRules'];
  if (Array.isArray(many) && many.length > 0) return many;
  return isObject(event['recurrenceRule']) ? [event['recurrenceRule']] : [];
}

/** Whether an event is one of several: it has a rule, or occurrences written out. */
export function repeats(event: Record<string, unknown>): boolean {
  return (
    rulesOf(event).length > 0 ||
    (isObject(event['recurrenceOverrides']) &&
      Object.keys(event['recurrenceOverrides']).length > 0)
  );
}

/** The days of a month a rule picks, in order. */
function daysOfMonth(
  rule: Rule,
  year: number,
  month: number,
  start: Wall,
): number[] {
  const length = daysIn(year, month);
  let days: number[] | null = null;
  if (rule.byMonthDay) {
    days = rule.byMonthDay
      .map((each) => (each < 0 ? length + 1 + each : each))
      .filter((each) => each >= 1 && each <= length);
  }
  if (rule.byDay) {
    const first = dayNumber(year, month, 1);
    const picked: number[] = [];
    for (const { day, nth } of rule.byDay) {
      const all: number[] = [];
      for (let each = 1; each <= length; each++) {
        if (weekdayOf(first + each - 1) === day) all.push(each);
      }
      if (nth === null) picked.push(...all);
      else {
        const one = nth > 0 ? all[nth - 1] : all[all.length + nth];
        if (one !== undefined) picked.push(one);
      }
    }
    days = days ? days.filter((each) => picked.includes(each)) : picked;
  }
  // With nothing said, the day of the month it started on, in the months that have one.
  days ??= start.day <= length ? [start.day] : [];
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Every date and time a rule comes to, from its start, in order. Ends when the rule does, or at `limit`. */
function* occurrencesOf(
  rule: Rule,
  start: string,
  limit: string,
): Generator<string> {
  const from = wall(start);
  const startDay = dayNumber(from.year, from.month, from.day);
  let made = 0;
  const emit = function* (candidates: string[]): Generator<string, boolean> {
    for (const each of candidates) {
      if (each < start) continue;
      if (each > limit || (rule.until !== null && each > rule.until)) {
        return false;
      }
      yield each;
      made += 1;
      if (rule.count !== null && made >= rule.count) return false;
    }
    return true;
  };
  // A rule that picks no day at all would otherwise be looked into for ever.
  for (let period = 0; period < 20_000; period++) {
    const step = period * rule.interval;
    let candidates: string[];
    /** The first moment of the period: past the limit, nothing in it or after it is wanted. */
    let opens: string;
    if (rule.frequency === 'daily') {
      const day = fromDayNumber(startDay + step);
      opens = local(day.year, day.month, day.day, '00:00:00');
      const fits =
        (!rule.byDay ||
          rule.byDay.some((each) => each.day === weekdayOf(startDay + step))) &&
        (!rule.byMonth || rule.byMonth.includes(day.month)) &&
        (!rule.byMonthDay || rule.byMonthDay.includes(day.day));
      candidates = fits ? [local(day.year, day.month, day.day, from.time)] : [];
    } else if (rule.frequency === 'weekly') {
      const weekStart =
        startDay - ((weekdayOf(startDay) - rule.firstDay + 7) % 7) + step * 7;
      const opening = fromDayNumber(weekStart);
      opens = local(opening.year, opening.month, opening.day, '00:00:00');
      const wanted = rule.byDay
        ? rule.byDay.map((each) => each.day)
        : [weekdayOf(startDay)];
      candidates = [...new Set(wanted)]
        .map((weekday) => weekStart + ((weekday - rule.firstDay + 7) % 7))
        .sort((a, b) => a - b)
        .map(fromDayNumber)
        .filter((day) => !rule.byMonth || rule.byMonth.includes(day.month))
        .map((day) => local(day.year, day.month, day.day, from.time));
    } else if (rule.frequency === 'monthly') {
      const months = from.year * 12 + (from.month - 1) + step;
      const year = Math.floor(months / 12);
      const month = (months % 12) + 1;
      opens = local(year, month, 1, '00:00:00');
      candidates =
        !rule.byMonth || rule.byMonth.includes(month)
          ? daysOfMonth(rule, year, month, from).map((day) =>
              local(year, month, day, from.time),
            )
          : [];
    } else {
      const year = from.year + step;
      opens = local(year, 1, 1, '00:00:00');
      const months = rule.byMonth ?? [from.month];
      candidates = [...new Set(months)]
        .sort((a, b) => a - b)
        .filter((month) => month >= 1 && month <= 12)
        .flatMap((month) =>
          daysOfMonth(rule, year, month, from).map((day) =>
            local(year, month, day, from.time),
          ),
        );
    }
    if (opens > limit) return;
    if (!(yield* emit(candidates))) return;
  }
}

/** One of the times an event that repeats is on. */
export interface Occurrence {
  /** When the rule says it is, on the event's wall: what tells it from the others. */
  recurrenceId: string;
  /** The event as it is that time: the event itself, with what was changed for this once. */
  event: Record<string, unknown>;
  utcStart: number;
  utcEnd: number;
}

/** What belongs to all of an event that repeats, and is no part of one occurrence. */
const OF_THE_SERIES = [
  'recurrenceRules',
  'recurrenceRule',
  'excludedRecurrenceRules',
  'recurrenceOverrides',
];

/** What cannot be different for one occurrence (RFC 8984 §4.3.5). */
export const NOT_FOR_ONE = [
  '@type',
  'uid',
  'calendarIds',
  'prodId',
  'method',
  'recurrenceId',
  'recurrenceIdTimeZone',
  'replyTo',
  'privacy',
  ...OF_THE_SERIES,
];

/** Sets what a path such as `locations/1/name` names, making what is on the way to it. */
function setAt(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let at = target;
  for (const part of parts.slice(0, -1)) {
    const next = at[part];
    const copy = isObject(next) ? { ...next } : {};
    at[part] = copy;
    at = copy;
  }
  const last = parts[parts.length - 1] as string;
  if (value === null) delete at[last];
  else at[last] = value;
}

function occurrence(
  event: Record<string, unknown>,
  recurrenceId: string,
  patch: Record<string, unknown>,
): Occurrence {
  const one: Record<string, unknown> = { ...event, start: recurrenceId };
  for (const property of OF_THE_SERIES) delete one[property];
  for (const [path, value] of Object.entries(patch)) {
    if (!NOT_FOR_ONE.includes(path.split('/')[0] ?? path)) {
      setAt(one, path, value);
    }
  }
  one['recurrenceId'] = recurrenceId;
  const zone = (one['timeZone'] as string | null | undefined) ?? null;
  const utcStart = zonedToUtc(String(one['start']), zone);
  return {
    recurrenceId,
    event: one,
    utcStart,
    utcEnd: utcStart + (durationMillis(String(one['duration'] ?? 'PT0S')) ?? 0),
  };
}

const MOST = 2000;

/**
 * The occurrences of an event that touch a span of the world's time, in
 * order: those its rules come to, without those taken out, with what was
 * changed for one of them, and with those written out one by one.
 */
export function expand(
  event: Record<string, unknown>,
  fromUtc: number,
  toUtc: number,
): Occurrence[] {
  const start = String(event['start']);
  const overrides = isObject(event['recurrenceOverrides'])
    ? event['recurrenceOverrides']
    : {};
  // Looked for on the wall a day past the span: no zone is further from UTC than that.
  const limit = new Date(toUtc + 86_400_000).toISOString().slice(0, 19);
  // And from as far before it as the event is long, and a day: what began earlier may still be on.
  const length = durationMillis(String(event['duration'] ?? 'PT0S')) ?? 0;
  const floor = new Date(fromUtc - length - 86_400_000)
    .toISOString()
    .slice(0, 19);
  const ids = new Set<string>();
  for (const given of rulesOf(event)) {
    const rule = readRule(given);
    if (!rule) continue;
    for (const each of occurrencesOf(rule, start, limit)) {
      if (each < floor) continue;
      ids.add(each);
      if (ids.size >= MOST) break;
    }
  }
  // The start is an occurrence whatever the rules say, and so is each one written out.
  if (start <= limit) ids.add(start);
  for (const [id, patch] of Object.entries(overrides)) {
    if (LOCAL_DATE_TIME.test(id) && isObject(patch) && id <= limit) ids.add(id);
  }
  if (Array.isArray(event['excludedRecurrenceRules'])) {
    for (const given of event['excludedRecurrenceRules']) {
      const rule = readRule(given);
      if (!rule) continue;
      for (const each of occurrencesOf(rule, start, limit)) ids.delete(each);
    }
  }
  return [...ids]
    .sort()
    .flatMap((id) => {
      const patch = overrides[id];
      if (isObject(patch) && patch['excluded'] === true) return [];
      return [occurrence(event, id, isObject(patch) ? patch : {})];
    })
    .filter((each) => each.utcEnd > fromUtc && each.utcStart < toUtc);
}

/** The occurrence of an event at one of its times, or undefined when it has none then. */
export function occurrenceAt(
  event: Record<string, unknown>,
  recurrenceId: string,
): Occurrence | undefined {
  if (!LOCAL_DATE_TIME.test(recurrenceId)) return undefined;
  const zone = (event['timeZone'] as string | null | undefined) ?? null;
  const at = zonedToUtc(recurrenceId, zone);
  // Where the rule puts it, whatever was changed about it since: a day either side covers a move.
  const overrides = isObject(event['recurrenceOverrides'])
    ? event['recurrenceOverrides']
    : {};
  const patch = overrides[recurrenceId];
  if (isObject(patch) && patch['excluded'] === true) return undefined;
  const bare = { ...event, recurrenceOverrides: {} };
  const found = expand(bare, at - 1, at + 1).some(
    (each) => each.recurrenceId === recurrenceId,
  );
  if (!found && !isObject(patch)) return undefined;
  return occurrence(event, recurrenceId, isObject(patch) ? patch : {});
}

/** The id an occurrence goes by: the event's, and when it is. Made of what an id may be made of. */
export const occurrenceId = (eventId: string, recurrenceId: string) =>
  `${eventId}_${recurrenceId.replace(/[-:]/g, '')}`;

/** An occurrence's id taken apart, or undefined for an id that is not one. */
export function parseOccurrenceId(
  id: string,
): { eventId: string; recurrenceId: string } | undefined {
  const found = /^(.+)_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!found) return undefined;
  const [, eventId, year, month, day, hour, minute, second] = found;
  return {
    eventId: eventId as string,
    recurrenceId: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
  };
}
