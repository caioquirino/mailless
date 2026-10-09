import { ObjectCache, sync, type JmapClient } from '@mailless/jmap-client';
import { CAPABILITY_CALENDARS, type Id } from '@mailless/jmap-core';

/*
 * The calendar: calendars and the events in them, as the server keeps them
 * (JMAP for Calendars, events as JSCalendar), and what a screen needs to show
 * a week of them and to write one.
 */

export interface Alert {
  '@type'?: 'Alert';
  trigger: { '@type'?: string; offset?: string };
  action?: string;
}

export interface RecurrenceRule {
  '@type'?: 'RecurrenceRule';
  frequency: string;
  interval?: number;
  count?: number;
  until?: string;
  byDay?: Array<{ day: string; nthOfPeriod?: number }>;
  [more: string]: unknown;
}

/** How an event comes again, of the ways the form offers. `custom` is any other way: kept as it is. */
export type Repeat =
  | 'none'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'yearly'
  | 'custom';

export const REPEATS: ReadonlyArray<{ repeat: Repeat; label: string }> = [
  { repeat: 'none', label: 'Does not repeat' },
  { repeat: 'daily', label: 'Every day' },
  { repeat: 'weekdays', label: 'Every weekday (Monday to Friday)' },
  { repeat: 'weekly', label: 'Every week' },
  { repeat: 'biweekly', label: 'Every two weeks' },
  { repeat: 'monthly', label: 'Every month' },
  { repeat: 'yearly', label: 'Every year' },
];

const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr'];

function ruleOf(repeat: Repeat, until: string): RecurrenceRule | null {
  const rule = (
    {
      none: null,
      custom: null,
      daily: { frequency: 'daily' },
      weekdays: {
        frequency: 'weekly',
        byDay: WEEKDAYS.map((day) => ({ day })),
      },
      weekly: { frequency: 'weekly' },
      biweekly: { frequency: 'weekly', interval: 2 },
      monthly: { frequency: 'monthly' },
      yearly: { frequency: 'yearly' },
    } as const
  )[repeat];
  if (!rule) return null;
  return {
    '@type': 'RecurrenceRule',
    ...rule,
    // Through the whole of its last day.
    ...(until === '' ? {} : { until: `${until}T23:59:59` }),
  };
}

/** Which of the ways the form offers a rule is, and the day it ends on. */
function repeatOf(
  event: Pick<CalendarEvent, 'recurrenceRules' | 'recurrenceRule'>,
): {
  repeat: Repeat;
  until: string;
} {
  const rules = event.recurrenceRules?.length
    ? event.recurrenceRules
    : event.recurrenceRule
      ? [event.recurrenceRule]
      : [];
  const [rule] = rules;
  if (!rule) return { repeat: 'none', until: '' };
  const {
    '@type': _type,
    frequency,
    interval = 1,
    until,
    byDay,
    ...more
  } = rule;
  const days = (byDay ?? []).map((each) => each.day).sort();
  const plain = byDay === undefined;
  const repeat: Repeat =
    rules.length > 1 || Object.keys(more).length > 0
      ? 'custom'
      : frequency === 'daily' && interval === 1 && plain
        ? 'daily'
        : frequency === 'weekly' && interval === 1 && plain
          ? 'weekly'
          : frequency === 'weekly' && interval === 2 && plain
            ? 'biweekly'
            : frequency === 'weekly' &&
                interval === 1 &&
                days.join() === [...WEEKDAYS].sort().join() &&
                (byDay ?? []).every((each) => each.nthOfPeriod === undefined)
              ? 'weekdays'
              : frequency === 'monthly' && interval === 1 && plain
                ? 'monthly'
                : frequency === 'yearly' && interval === 1 && plain
                  ? 'yearly'
                  : 'custom';
  return { repeat, until: until?.slice(0, 10) ?? '' };
}

export interface Participant {
  '@type'?: 'Participant';
  name?: string;
  email?: string;
  sendTo?: { imip?: string };
  /** What they answered: `accepted`, `declined`, `tentative`, or `needs-action`. */
  participationStatus?: string;
  roles?: Record<string, boolean>;
  expectReply?: boolean;
}

/** An address the person using this goes by, and the name they write under. */
export interface Own {
  email: string;
  name?: string | null;
}

export type Answer = 'accepted' | 'tentative' | 'declined';

const lower = (email: string | undefined) => (email ?? '').trim().toLowerCase();

/** The address of whoever an event is from, or null for one with nobody else on it. */
export function organizerOf(
  event: Pick<CalendarEvent, 'replyTo'>,
): string | null {
  const imip = event.replyTo?.imip;
  return imip ? lower(imip.replace(/^mailto:/i, '')) : null;
}

/** The entry of the person using this among those on an event, with its key. */
export function ownEntry(
  event: Pick<CalendarEvent, 'participants'>,
  own: readonly Own[],
): [string, Participant] | undefined {
  const mine = new Set(own.map((each) => lower(each.email)));
  return Object.entries(event.participants ?? {}).find(([, each]) =>
    mine.has(lower(each.email)),
  );
}

export interface Calendar {
  id: Id;
  name: string;
  /** As `#rrggbb`, or null when none was chosen. */
  color: string | null;
  sortOrder: number;
  isVisible: boolean;
  isDefault: boolean;
  defaultAlertsWithTime: Record<string, Alert> | null;
}

export interface CalendarEvent {
  id: Id;
  calendarIds: Record<Id, true>;
  title?: string;
  description?: string;
  /** The date and time on the wall of `timeZone`: `2026-10-09T13:00:00`. */
  start: string;
  duration?: string;
  timeZone?: string | null;
  /** A whole day, or several: shown without a time. */
  showWithoutTime?: boolean;
  locations?: Record<string, { name?: string }> | null;
  virtualLocations?: Record<string, { uri?: string }> | null;
  participants?: Record<string, Participant> | null;
  /** Whoever it is from, for an event with people on it: `{ imip: 'mailto:…' }`. */
  replyTo?: { imip?: string } | null;
  status?: string;
  uid?: string;
  alerts?: Record<string, Alert> | null;
  useDefaultAlerts?: boolean;
  /** When it comes again, for one that repeats. */
  recurrenceRules?: RecurrenceRule[] | null;
  recurrenceRule?: RecurrenceRule | null;
  /** For one of the times of an event that repeats: the event, and which of its times. */
  baseEventId?: Id;
  recurrenceId?: string;
  /** When it is, in the world's time: worked out by the server. */
  utcStart: string;
  utcEnd: string;
}

/** An event read out of a calendar file: what an invitation that came with a message says. */
export interface Invitation extends CalendarEvent {
  /** What the file is for: `request` is an invitation, `reply` an answer to one, `cancel` word that it is off. */
  method?: string;
}

export class CalendarError extends Error {}

/** The colour of a calendar that has none of its own. */
export const DEFAULT_COLOR = '#2456c8';

export const CALENDAR_COLORS: ReadonlyArray<{ color: string; name: string }> = [
  { color: '#2456c8', name: 'Blue' },
  { color: '#7c3aed', name: 'Purple' },
  { color: '#1e7b4a', name: 'Green' },
  { color: '#b45309', name: 'Amber' },
  { color: '#0e7490', name: 'Teal' },
  { color: '#b3261e', name: 'Red' },
  { color: '#5a6575', name: 'Grey' },
];

// -------------------------------------------------------------------- dates

const pad = (value: number) => String(value).padStart(2, '0');

/** A day as `2026-10-09`, by the clock of whoever is looking. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day a key names, at its first moment. Today for a key that names none. */
export function dayOf(key: string | undefined): Date {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? '');
  const date = found
    ? new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3]))
    : new Date();
  if (Number.isNaN(date.getTime())) return dayOf(undefined);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** The Monday of the week a day is in. */
export function weekStart(date: Date): Date {
  const day = dayOf(dayKey(date));
  return addDays(day, -((day.getDay() + 6) % 7));
}

export const timeOf = (date: Date) =>
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** "5 – 11 October 2026", or with both months when the week is in two. */
export function weekTitle(start: Date, locale?: string): string {
  const end = addDays(start, 6);
  const month = (date: Date) =>
    date.toLocaleDateString(locale, { month: 'long' });
  const year = end.getFullYear();
  return start.getMonth() === end.getMonth()
    ? `${start.getDate()} – ${end.getDate()} ${month(end)} ${year}`
    : `${start.getDate()} ${month(start)} – ${end.getDate()} ${month(end)} ${year}`;
}

/** The time zone of whoever is looking: `Europe/Lisbon`. */
export const ownTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ------------------------------------------------------- an event on a screen

/** When an event is, by the clock of whoever is looking. */
export interface Shown {
  event: CalendarEvent;
  start: Date;
  /** The moment it ends: for a whole day, the first moment of the day after. */
  end: Date;
  allDay: boolean;
}

function days(duration: string | undefined): number {
  const found = /^P(?:(\d+)W)?(?:(\d+)D)?/.exec(duration ?? '');
  return Math.max(1, Number(found?.[1] ?? 0) * 7 + Number(found?.[2] ?? 0));
}

export function shown(event: CalendarEvent): Shown {
  if (event.showWithoutTime) {
    // A day is a day wherever it is looked at from.
    const start = dayOf(event.start.slice(0, 10));
    return {
      event,
      start,
      end: addDays(start, days(event.duration)),
      allDay: true,
    };
  }
  return {
    event,
    start: new Date(event.utcStart),
    end: new Date(event.utcEnd),
    allDay: false,
  };
}

export interface Placed extends Shown {
  /** Which of the columns side by side it is in, and how many there are. */
  column: number;
  columns: number;
}

/**
 * Puts the events of one day side by side where they overlap, as few columns
 * as will do: each group of events that touch one another shares its width.
 */
export function placeDay(events: readonly Shown[]): Placed[] {
  const sorted = [...events].sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      b.end.getTime() - a.end.getTime(),
  );
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = 0;
  const close = () => {
    const columns = Math.max(0, ...group.map((each) => each.column)) + 1;
    for (const each of group) each.columns = columns;
    group = [];
  };
  for (const each of sorted) {
    if (group.length > 0 && each.start.getTime() >= groupEnd) close();
    const taken = new Set(
      group
        .filter((other) => other.end.getTime() > each.start.getTime())
        .map((other) => other.column),
    );
    let column = 0;
    while (taken.has(column)) column++;
    const one: Placed = { ...each, column, columns: 1 };
    group.push(one);
    placed.push(one);
    groupEnd = Math.max(groupEnd, each.end.getTime());
  }
  close();
  return placed;
}

// ---------------------------------------------------------------- the form

/** An event as someone writes it: what the fields of the form hold. */
export interface EventForm {
  /** Null for an event that is not kept yet. */
  id: Id | null;
  title: string;
  /** `2026-10-09`. */
  date: string;
  /** The last day of it, for one that takes several. */
  endDate: string;
  /** `13:00`. */
  from: string;
  to: string;
  allDay: boolean;
  calendarId: Id;
  place: string;
  /** The others on it: addresses, with commas between them. */
  people: string;
  /** What each of them answered, by address. Carried along; not something the form changes. */
  answers: Record<string, string>;
  /** The address it is from, of those the person goes by. Empty for the first of them. */
  as: string;
  /**
   * For an event someone else invited to: who, and what was answered. The
   * people on it are theirs to change, not the person's who was invited.
   */
  invited: { by: string; answer: string } | null;
  /** Where to join it from afar. */
  link: string;
  notes: string;
  /** Minutes before, for each reminder. Null for the calendar's own. */
  reminders: number[] | null;
  /** How it comes again, and the last day it does: empty for no last day. */
  repeat: Repeat;
  until: string;
  /**
   * For one of the times of an event that repeats: the event it is a time
   * of, which time, and whether what is written is for this once or for all.
   */
  series: { id: Id; recurrenceId: string; all: boolean } | null;
}

/** The parts of the form that start folded away, and open when they hold something. */
export type FormPart =
  'repeat' | 'place' | 'people' | 'link' | 'notes' | 'reminders';

export function usedParts(form: EventForm): FormPart[] {
  return (
    [
      ['repeat', form.repeat !== 'none'],
      ['place', form.place !== ''],
      ['people', form.people !== ''],
      ['link', form.link !== ''],
      ['reminders', form.reminders !== null],
      ['notes', form.notes !== ''],
    ] as const
  )
    .filter(([, used]) => used)
    .map(([part]) => part);
}

export function newForm(
  calendarId: Id,
  start: Date,
  end?: Date,
  allDay = false,
): EventForm {
  const until = end ?? new Date(start.getTime() + 3_600_000);
  return {
    id: null,
    title: '',
    date: dayKey(start),
    endDate: dayKey(allDay ? addDays(until, -1) : until),
    from: timeOf(start),
    to: timeOf(until),
    allDay,
    calendarId,
    place: '',
    people: '',
    answers: {},
    as: '',
    invited: null,
    link: '',
    notes: '',
    reminders: null,
    repeat: 'none',
    until: '',
    series: null,
  };
}

const first = <T>(map: Record<string, T> | null | undefined): T | undefined =>
  Object.values(map ?? {})[0];

/** How long before, in minutes, an alert goes off. Null for one that says something else. */
function minutesBefore(alert: Alert): number | null {
  const found = /^-P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(
    alert.trigger.offset ?? '',
  );
  if (!found) return alert.trigger.offset === 'PT0S' ? 0 : null;
  const [weeks, day, hours, minutes] = found
    .slice(1)
    .map((part) => Number(part ?? 0));
  return (
    (((weeks ?? 0) * 7 + (day ?? 0)) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)
  );
}

export function remindersOf(
  alerts: Record<string, Alert> | null | undefined,
): number[] {
  return Object.values(alerts ?? {})
    .map(minutesBefore)
    .filter((minutes): minutes is number => minutes !== null)
    .sort((a, b) => a - b);
}

/**
 * The form of an event. For one of the times of an event that repeats, give
 * the event too: how it repeats is the event's to say.
 */
export function formOf(
  event: CalendarEvent,
  whole?: CalendarEvent,
  own: readonly Own[] = [],
): EventForm {
  const { start, end, allDay } = shown(event);
  const organizer = organizerOf(event);
  const mine = new Set(own.map((each) => lower(each.email)));
  const theirs = organizer !== null && !mine.has(organizer);
  // The others: everyone but whoever it is from, and but the person themselves when it is theirs.
  const others = Object.values(event.participants ?? {}).filter(
    (person) =>
      person.email &&
      lower(person.email) !== organizer &&
      (theirs || !mine.has(lower(person.email))),
  );
  return {
    id: event.id,
    title: event.title ?? '',
    date: dayKey(start),
    endDate: dayKey(allDay ? addDays(end, -1) : end),
    from: allDay ? '09:00' : timeOf(start),
    to: allDay ? '10:00' : timeOf(end),
    allDay,
    calendarId: Object.keys(event.calendarIds)[0] ?? '',
    place: first(event.locations)?.name ?? '',
    people: others.map((person) => lower(person.email)).join(', '),
    answers: Object.fromEntries(
      others.map((person) => [
        lower(person.email),
        person.participationStatus ?? 'needs-action',
      ]),
    ),
    as: organizer !== null && !theirs ? organizer : '',
    invited: theirs
      ? {
          by: organizer,
          answer:
            ownEntry(event, own)?.[1].participationStatus ?? 'needs-action',
        }
      : null,
    link: first(event.virtualLocations)?.uri ?? '',
    notes: event.description ?? '',
    reminders:
      event.useDefaultAlerts === false ? remindersOf(event.alerts) : null,
    ...repeatOf(whole ?? event),
    series:
      event.baseEventId && event.recurrenceId
        ? {
            id: event.baseEventId,
            recurrenceId: event.recurrenceId,
            all: false,
          }
        : null,
  };
}

/** The moments a form says, by the clock of whoever is writing it. */
export function formSpan(form: EventForm): { start: Date; end: Date } {
  const at = (date: string, time: string) => {
    const day = dayOf(date);
    const [hours, minutes] = time.split(':').map(Number);
    day.setHours(hours ?? 0, minutes ?? 0, 0, 0);
    return day;
  };
  if (form.allDay) {
    const start = dayOf(form.date);
    const last = dayOf(form.endDate < form.date ? form.date : form.endDate);
    return { start, end: addDays(last, 1) };
  }
  const start = at(form.date, form.from);
  let end = at(form.endDate < form.date ? form.date : form.endDate, form.to);
  // An end before the start is on the day after: 23:00 to 01:00.
  if (end.getTime() <= start.getTime()) end = addDays(end, 1);
  return { start, end };
}

/** A form with its time set to a span of the clock: what dragging on the calendar does. */
export function withSpan(form: EventForm, start: Date, end: Date): EventForm {
  return {
    ...form,
    allDay: false,
    date: dayKey(start),
    // Ending at midnight is ending on the day it began.
    endDate: dayKey(new Date(Math.max(start.getTime(), end.getTime() - 1))),
    from: timeOf(start),
    to: timeOf(end),
  };
}

/** What stops a form from being kept, in words, or null. */
export function formProblem(form: EventForm): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return 'Choose a day.';
  if (
    !form.allDay &&
    !(/^\d{2}:\d{2}$/.test(form.from) && /^\d{2}:\d{2}$/.test(form.to))
  ) {
    return 'Choose when it starts and ends.';
  }
  const wrong = addresses(form.people).find(
    (address) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address),
  );
  if (wrong) return `“${wrong}” is not an address.`;
  if (form.link !== '' && !/^https?:\/\/\S+$/i.test(form.link.trim())) {
    return 'The link has to start with https://';
  }
  return null;
}

const addresses = (people: string): string[] =>
  people
    .split(/[,;\s]+/)
    .map((address) => address.trim())
    .filter(Boolean);

function offset(minutes: number): string {
  if (minutes === 0) return 'PT0S';
  const day = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const time = `${hours ? `${hours}H` : ''}${rest ? `${rest}M` : ''}`;
  return `-P${day ? `${day}D` : ''}${time ? `T${time}` : ''}`;
}

/** A form as the properties of a JSCalendar event, for the server. */
export function eventOf(
  form: EventForm,
  timeZone: string,
  /** The addresses the person goes by: one of them is who an event with people on it is from. */
  own: readonly Own[] = [],
): Record<string, unknown> {
  const { start, end } = formSpan(form);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const whole = Math.round(minutes / 1440);
  const people = addresses(form.people).map(lower);
  const me = own.find((each) => lower(each.email) === lower(form.as)) ?? own[0];
  return {
    calendarIds: { [form.calendarId]: true },
    title: form.title.trim(),
    start: form.allDay
      ? `${dayKey(start)}T00:00:00`
      : `${dayKey(start)}T${timeOf(start)}:00`,
    duration: form.allDay
      ? `P${Math.max(1, whole)}D`
      : `PT${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}H` : ''}${minutes % 60 || minutes === 0 ? `${minutes % 60}M` : ''}`,
    // A whole day is the same day everywhere: it has no zone.
    timeZone: form.allDay ? null : timeZone,
    showWithoutTime: form.allDay,
    description: form.notes.trim() === '' ? null : form.notes,
    locations:
      form.place.trim() === ''
        ? null
        : { '1': { '@type': 'Location', name: form.place.trim() } },
    virtualLocations:
      form.link.trim() === ''
        ? null
        : { '1': { '@type': 'VirtualLocation', uri: form.link.trim() } },
    // Who is on someone else's event is theirs to say: nothing is said of it here.
    ...(form.invited
      ? {}
      : people.length === 0
        ? { participants: null, replyTo: null }
        : {
            replyTo: me ? { imip: `mailto:${lower(me.email)}` } : null,
            participants: Object.fromEntries([
              ...(me
                ? [
                    [
                      'me',
                      {
                        '@type': 'Participant',
                        ...(me.name ? { name: me.name } : {}),
                        email: lower(me.email),
                        sendTo: { imip: `mailto:${lower(me.email)}` },
                        participationStatus: 'accepted',
                        roles: { owner: true, attendee: true },
                      },
                    ],
                  ]
                : []),
              ...people
                .filter((email) => email !== lower(me?.email))
                .map((email, index) => [
                  String(index + 1),
                  {
                    '@type': 'Participant',
                    email,
                    sendTo: { imip: `mailto:${email}` },
                    participationStatus: form.answers[email] ?? 'needs-action',
                    expectReply: true,
                    roles: { attendee: true },
                  },
                ]),
            ]),
          }),
    useDefaultAlerts: form.reminders === null,
    alerts:
      form.reminders === null || form.reminders.length === 0
        ? null
        : Object.fromEntries(
            form.reminders.map((each, index) => [
              String(index + 1),
              {
                '@type': 'Alert',
                trigger: { '@type': 'OffsetTrigger', offset: offset(each) },
                action: 'display',
              },
            ]),
          ),
    // A way of repeating the form does not know is left as it is.
    ...(form.repeat === 'custom'
      ? {}
      : {
          recurrenceRules:
            form.repeat === 'none' ? null : [ruleOf(form.repeat, form.until)],
          recurrenceRule: null,
        }),
  };
}

/** What can be different for one of the times of an event that repeats. */
const FOR_ONE = [
  'title',
  'start',
  'duration',
  'timeZone',
  'showWithoutTime',
  'description',
  'locations',
  'virtualLocations',
  'participants',
  'useDefaultAlerts',
  'alerts',
];

/** A date and time on a wall, so many minutes later. */
function later(local: string, minutes: number): string {
  return new Date(Date.parse(`${local}Z`) + minutes * 60_000)
    .toISOString()
    .slice(0, 19);
}

/** "30 minutes before", "1 day before", "When it starts". */
export function reminderText(minutes: number): string {
  if (minutes === 0) return 'When it starts';
  const [count, unit] =
    minutes % 10080 === 0
      ? [minutes / 10080, 'week']
      : minutes % 1440 === 0
        ? [minutes / 1440, 'day']
        : minutes % 60 === 0
          ? [minutes / 60, 'hour']
          : [minutes, 'minute'];
  return `${count} ${unit}${count === 1 ? '' : 's'} before`;
}

export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

// ---------------------------------------------------------------- the store

interface SetResponse {
  created?: Record<string, { id: Id }> | null;
  notCreated?: Record<string, { type: string; description?: string }> | null;
  notUpdated?: Record<string, { type: string; description?: string }> | null;
  notDestroyed?: Record<string, { type: string }> | null;
}

/** What is asked of an event to show it. When it is in the world's time is only said when asked for by name. */
const SHOWN_PROPERTIES = [
  'calendarIds',
  'title',
  'description',
  'start',
  'duration',
  'timeZone',
  'showWithoutTime',
  'locations',
  'virtualLocations',
  'participants',
  'alerts',
  'useDefaultAlerts',
  'replyTo',
  'status',
  'uid',
  'utcStart',
  'utcEnd',
];

export class Calendars {
  readonly calendars: ObjectCache<Calendar>;
  readonly events: ObjectCache<CalendarEvent>;
  /** Whether this server keeps calendars at all. Known once started. */
  available = false;
  /** The addresses the person goes by: the first is the one they write from. Known once started. */
  own: Own[] = [];
  private started: Promise<void> | undefined;

  constructor(private readonly client: JmapClient) {
    this.calendars = new ObjectCache<Calendar>(client, {
      type: 'Calendar',
      everything: true,
    });
    this.events = new ObjectCache<CalendarEvent>(client, {
      type: 'CalendarEvent',
      everything: true,
      properties: [...SHOWN_PROPERTIES, 'recurrenceRules', 'recurrenceRule'],
    });
  }

  // What is on in the time being looked at, each time of an event that
  // repeats by itself. Asked of the server, which is what knows when those are.
  private window: { from: number; to: number; events: CalendarEvent[] } | null =
    null;
  private wanted: { from: number; to: number } | null = null;
  private readonly listeners = new Set<() => void>();
  /** Goes up when what is on in the time looked at was fetched again. */
  version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Says which time is being looked at. What is on in it is fetched, and
   * kept up to date for as long as it is the time looked at.
   */
  async watch(from: Date, to: Date): Promise<void> {
    const span = { from: from.getTime(), to: to.getTime() };
    if (
      this.wanted &&
      this.wanted.from <= span.from &&
      this.wanted.to >= span.to
    ) {
      return;
    }
    this.wanted = span;
    await this.fetchWindow();
  }

  private async fetchWindow(): Promise<void> {
    const wanted = this.wanted;
    if (!this.available || !wanted) return;
    const wall = (moment: number) => {
      const date = new Date(moment);
      return `${dayKey(date)}T${timeOf(date)}:00`;
    };
    const found = (await this.client.call(
      'CalendarEvent/query' as never,
      {
        filter: { after: wall(wanted.from), before: wall(wanted.to) },
        expandRecurrences: true,
        timeZone: ownTimeZone(),
      } as never,
    )) as { ids: Id[] };
    const got =
      found.ids.length === 0
        ? { list: [] }
        : ((await this.client.call(
            'CalendarEvent/get' as never,
            {
              ids: found.ids,
              properties: [...SHOWN_PROPERTIES, 'baseEventId', 'recurrenceId'],
            } as never,
          )) as { list: CalendarEvent[] });
    // Another time was asked for meanwhile: this answer is to an old question.
    if (this.wanted !== wanted) return;
    this.window = { ...wanted, events: got.list };
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  /** Fetches the calendars and what is in them, once. */
  start(): Promise<void> {
    this.started ??= this.load().catch((error: unknown) => {
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  private async load(): Promise<void> {
    const session = await this.client.session();
    this.available = session.capabilities[CAPABILITY_CALENDARS] !== undefined;
    if (!this.available) return;
    const batch = this.client.batch();
    const calendars = this.calendars.loadIn(batch, null);
    const events = this.events.loadIn(batch, null);
    const result = await batch.send();
    calendars.done(result);
    events.done(result);
    // Who the person is to the others on an event. An account that cannot send has nobody to tell.
    this.own = await this.client.call('Identity/get', { ids: null }).then(
      (found) =>
        found.list.map((identity) => ({
          email: identity.email,
          name: identity.name,
        })),
      () => [],
    );
  }

  /** Brings what is held up to date with what another device, or window, changed. */
  async refresh(): Promise<void> {
    if (!this.available || !this.events.isComplete) return;
    const before = this.events.version;
    await sync(this.client, [this.calendars, this.events]);
    if (this.events.version !== before) await this.fetchWindow();
  }

  /** The calendars, in the order they are listed. */
  all(): Calendar[] {
    return [...this.calendars.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
  }

  /** The calendar new events go in when none is chosen. */
  defaultCalendar(): Calendar | undefined {
    const all = this.all();
    return all.find((calendar) => calendar.isDefault) ?? all[0];
  }

  colorOf(event: Pick<CalendarEvent, 'calendarIds'>): string {
    const id = Object.keys(event.calendarIds)[0];
    return (id && this.calendars.get(id)?.color) || DEFAULT_COLOR;
  }

  /** What is on between two moments, in the calendars that are shown, earliest first. */
  between(from: Date, to: Date): Shown[] {
    const visible = new Set(
      this.calendars
        .values()
        .filter((calendar) => calendar.isVisible)
        .map((calendar) => calendar.id),
    );
    // Outside the time looked at, events are known by themselves and not by each of their times.
    const known =
      this.window &&
      this.window.from <= from.getTime() &&
      this.window.to >= to.getTime()
        ? this.window.events
        : this.events.values();
    return known
      .filter(
        (event) =>
          // What whoever invited has called off is not on any more.
          event.status !== 'cancelled' &&
          Object.keys(event.calendarIds).some((id) => visible.has(id)),
      )
      .map(shown)
      .filter(
        (each) =>
          each.end.getTime() > from.getTime() &&
          each.start.getTime() < to.getTime(),
      )
      .sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          a.start.getTime() - b.start.getTime(),
      );
  }

  private async set(
    type: 'Calendar' | 'CalendarEvent',
    given: Record<string, unknown>,
    /** Tells the people on each event what was done to it, by mail. */
    tell = false,
  ): Promise<SetResponse> {
    const args = tell ? { ...given, sendSchedulingMessages: true } : given;
    const response = (await this.client.call(
      `${type}/set` as never,
      args as never,
    )) as SetResponse;
    await this.refresh();
    const refused = [
      ...Object.values(response.notCreated ?? {}),
      ...Object.values(response.notUpdated ?? {}),
      ...Object.values(response.notDestroyed ?? {}),
    ].find((error) => error.type !== 'notFound');
    if (refused) {
      throw new CalendarError(
        refused.type === 'invalidProperties'
          ? 'The server would not keep it as written.'
          : refused.type === 'calendarHasEvent'
            ? 'The calendar still has events in it.'
            : 'The server refused the change.',
      );
    }
    return response;
  }

  /** Keeps an event: a new one when the form has no id. Returns its id. */
  async save(form: EventForm, tell = false): Promise<Id> {
    const problem = formProblem(form);
    if (problem) throw new CalendarError(problem);
    const event = eventOf(form, ownTimeZone(), this.own);
    if (form.id === null) {
      const said = Object.fromEntries(
        Object.entries(event).filter(([, value]) => value !== null),
      );
      const response = await this.set(
        'CalendarEvent',
        { create: { new: said } },
        tell,
      );
      const id = response.created?.['new']?.id;
      if (!id) throw new CalendarError('The event could not be kept.');
      return id;
    }
    if (form.series && !form.series.all) {
      // This once: what was changed about this time, of what can be different
      // for one, and nothing of how it repeats. What was left alone goes on
      // following the event.
      const shownNow = this.window?.events.find((each) => each.id === form.id);
      const was = shownNow
        ? eventOf(
            formOf(shownNow, undefined, this.own),
            ownTimeZone(),
            this.own,
          )
        : {};
      const once = Object.fromEntries(
        Object.entries(event).filter(
          ([property, value]) =>
            FOR_ONE.includes(property) &&
            JSON.stringify(value) !== JSON.stringify(was[property]),
        ),
      );
      if (Object.keys(once).length > 0) {
        await this.set('CalendarEvent', { update: { [form.id]: once } }, tell);
      }
      return form.id;
    }
    if (form.series) {
      // Every time: the event itself. It starts as much later as this time of it was moved.
      const whole = this.events.get(form.series.id);
      if (!whole) throw new CalendarError('The event is no longer there.');
      const moved =
        (Date.parse(`${String(event['start'])}Z`) -
          Date.parse(`${form.series.recurrenceId}Z`)) /
        60_000;
      await this.set(
        'CalendarEvent',
        {
          update: {
            [form.series.id]: { ...event, start: later(whole.start, moved) },
          },
        },
        tell,
      );
      return form.series.id;
    }
    await this.set('CalendarEvent', { update: { [form.id]: event } }, tell);
    return form.id;
  }

  /**
   * Answers an invitation that is in the calendar already, and tells whoever
   * it is from. `id` is the event's, not that of one of its times.
   */
  async answer(id: Id, answer: Answer): Promise<void> {
    const event = this.events.get(id);
    const mine = event ? ownEntry(event, this.own) : undefined;
    if (!mine) throw new CalendarError('You are not among those invited.');
    await this.set(
      'CalendarEvent',
      {
        update: {
          [id]: { [`participants/${mine[0]}/participationStatus`]: answer },
        },
      },
      true,
    );
  }

  /** The event a calendar file holds: an invitation that came with a message, for one. Null when it holds none. */
  async parse(blobId: Id): Promise<Invitation | null> {
    const read = (await this.client.call(
      'CalendarEvent/parse' as never,
      { blobIds: [blobId] } as never,
    )) as { parsed?: Record<string, Invitation> | null };
    return read.parsed?.[blobId] ?? null;
  }

  /** The event of the calendar that an invitation is for, when it is in it. */
  known(invitation: Pick<Invitation, 'uid'>): CalendarEvent | undefined {
    return this.events
      .values()
      .find((event) => event.uid !== undefined && event.uid === invitation.uid);
  }

  /**
   * Answers an invitation that came with a message: the event is put in the
   * calendar when it is not there yet, and whoever it is from is told.
   */
  async respond(invitation: Invitation, answer: Answer): Promise<void> {
    const known = this.known(invitation);
    if (known) return this.answer(known.id, answer);
    const into = this.defaultCalendar();
    if (!into) throw new CalendarError('There is no calendar to put it in.');
    const mine = ownEntry(invitation, this.own);
    if (!mine) throw new CalendarError('You are not among those invited.');
    const {
      id: _id,
      method: _method,
      utcStart: _start,
      utcEnd: _end,
      ...event
    } = invitation;
    await this.set(
      'CalendarEvent',
      {
        create: {
          new: {
            ...event,
            calendarIds: { [into.id]: true },
            // Reminded of as the rest of the calendar is.
            useDefaultAlerts: true,
            participants: {
              ...invitation.participants,
              [mine[0]]: { ...mine[1], participationStatus: answer },
            },
          },
        },
      },
      true,
    );
  }

  /** All of an event as the server has it, more than is shown here. */
  private async whole(id: Id): Promise<Record<string, unknown> | undefined> {
    const got = (await this.client.call(
      'CalendarEvent/get' as never,
      { ids: [id] } as never,
    )) as { list: Record<string, unknown>[] };
    return got.list[0];
  }

  /**
   * Removes an event, or for one of the times of an event that repeats that
   * one time unless all of them are asked for. Returns the way to put back
   * what was removed, as it was.
   */
  async remove(
    event: Pick<CalendarEvent, 'id' | 'baseEventId'>,
    all = false,
    tell = false,
  ): Promise<() => Promise<void>> {
    if (event.baseEventId && !all) {
      const before = await this.whole(event.baseEventId);
      await this.set('CalendarEvent', { destroy: [event.id] }, tell);
      const seriesId = event.baseEventId;
      return async () => {
        await this.set('CalendarEvent', {
          update: {
            [seriesId]: {
              recurrenceOverrides: before?.['recurrenceOverrides'] ?? null,
            },
          },
        });
      };
    }
    const id = event.baseEventId ?? event.id;
    const was = await this.whole(id);
    await this.set('CalendarEvent', { destroy: [id] }, tell);
    return async () => {
      if (!was) return;
      const { id: _id, isOrigin: _origin, ...rest } = was;
      await this.set('CalendarEvent', { create: { new: rest } });
    };
  }

  /** Shows or hides a calendar, on every device. */
  async setVisible(id: Id, isVisible: boolean): Promise<void> {
    await this.set('Calendar', { update: { [id]: { isVisible } } });
  }

  async makeCalendar(name: string, color: string): Promise<void> {
    await this.set('Calendar', { create: { new: { name, color } } });
  }

  /** Makes a calendar the one new events go in. */
  async setDefault(id: Id): Promise<void> {
    await this.set('Calendar', { onSuccessSetIsDefault: id });
  }

  async changeCalendar(
    id: Id,
    change: { name?: string; color?: string },
  ): Promise<void> {
    await this.set('Calendar', { update: { [id]: change } });
  }

  /** Removes a calendar and everything in it. */
  async removeCalendar(id: Id): Promise<void> {
    await this.set('Calendar', {
      destroy: [id],
      onDestroyRemoveEvents: true,
    });
  }
}

// ------------------------------------------------------ between two windows

/**
 * What the windows of one browser tell one another about an event being
 * written: where it would be, so that the calendar can show it while it is
 * written elsewhere, and that it was kept or dropped.
 */
export type WindowMessage =
  | { kind: 'writing'; key: string; form: EventForm }
  | { kind: 'kept'; key: string }
  | { kind: 'closed'; key: string };

export const CHANNEL = 'mailless.calendar';
/** Where a form being written is kept, so that reloading its window does not lose it. */
export const draftKey = (key: string) => `mailless.calendar.draft.${key}`;

export function readDraft(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): EventForm | null {
  try {
    const kept = JSON.parse(storage.getItem(draftKey(key)) ?? 'null');
    return kept && typeof kept === 'object' && typeof kept.date === 'string'
      ? (kept as EventForm)
      : null;
  } catch {
    return null;
  }
}
