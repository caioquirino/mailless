import {
  applyPatch,
  CAPABILITY_CALENDARS,
  GetArgumentsSchema,
  MethodError,
  PatchError,
  QueryArgumentsSchema,
  QueryChangesArgumentsSchema,
  SetArgumentsSchema,
  SetFailure,
  type Comparator,
  type SetError,
} from '@mailless/jmap-core';
import { z } from 'zod';
import {
  changesSince,
  commit,
  compareStrings,
  filterAndSort,
  fingerprint,
  generateId,
  loadForGet,
  paginate,
  parseArguments,
  pick,
  queryChanges,
  requireAccount,
  requireCopyAccounts,
  requiredConditionValues,
  resolveCreationReference,
  retryOnConflict,
  selectProperties,
  standardChanges,
  standardSet,
  toChangesResponse,
  toUtcDate,
  type CompareFn,
  type MethodContext,
  type MethodHandler,
  type QuerySpec,
  type StoredRecord,
  type WriteOp,
} from '@mailless/jmap-engine';
import {
  attendeesOf,
  fromICalendar,
  organizerOf,
  toICalendar,
} from './icalendar.js';
import {
  expand,
  NOT_FOR_ONE,
  occurrenceAt,
  occurrenceId,
  parseOccurrenceId,
  repeats,
} from './recurrence.js';
import { messagesFor, whenText, type Scheduling } from './scheduling.js';
import {
  durationMillis,
  isTimeZone,
  LOCAL_DATE_TIME,
  zonedToUtc,
} from './time.js';

/** What the calendar methods need besides what every method has. */
export interface CalendarsContext {
  /** Present when the server can tell the people on an event about it. */
  scheduling?: Scheduling;
  /** Told when one of them could not be told. The event is kept all the same. */
  onSchedulingError?: (error: unknown) => void;
}

declare module '@mailless/jmap-engine' {
  interface MethodContext {
    /** Set by the calendars module on every context. */
    calendars: CalendarsContext;
  }
}

/*
 * Calendars, and the events in them, as JMAP for Calendars has them. An
 * event is a JSCalendar Event (RFC 8984): what a client sends is kept as it
 * is, so that what this server does not know about survives a round trip,
 * and only what it relies on is checked.
 */

export { CAPABILITY_CALENDARS };

export const CALENDAR = 'Calendar';
export const CALENDAR_EVENT = 'CalendarEvent';

const SETTINGS = 'CalendarSettings';
const SETTINGS_ID = 'settings';
/** An event is a few lines of text; this is room for a long description and many people. */
export const MAX_EVENT_OCTETS = 128 * 1024;
const EVENTS_PER_COMMIT = 10;
const COLOR = /^#[0-9a-fA-F]{6}$/;

const invalid = (properties: string[], description: string): SetFailure =>
  new SetFailure('invalidProperties', description, { properties });

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const encoder = new TextEncoder();

// ---------------------------------------------------------------- calendars

interface CalendarValue {
  name: string;
  description: string | null;
  /** As `#rrggbb`, or null for the client to choose. */
  color: string | null;
  sortOrder: number;
  isSubscribed: boolean;
  isVisible: boolean;
  /** The reminders an event gets when it says to use the calendar's own. */
  defaultAlertsWithTime: Record<string, unknown> | null;
  defaultAlertsWithoutTime: Record<string, unknown> | null;
  timeZone: string | null;
}

const CALENDAR_PROPERTIES = [
  'id',
  'name',
  'description',
  'color',
  'sortOrder',
  'isSubscribed',
  'isVisible',
  'isDefault',
  'includeInAvailability',
  'defaultAlertsWithTime',
  'defaultAlertsWithoutTime',
  'timeZone',
  'shareWith',
  'myRights',
];

async function defaultCalendarId(ctx: MethodContext): Promise<string | null> {
  const [settings] = await ctx.store.get(ctx.auth.accountId, SETTINGS, [
    SETTINGS_ID,
  ]);
  return (settings?.value['defaultCalendarId'] as string | null) ?? null;
}

function describeCalendar(
  ctx: MethodContext,
  id: string,
  value: CalendarValue,
  defaultId: string | null,
): Record<string, unknown> {
  const mayWrite = !ctx.isReadOnly;
  return {
    id,
    name: value.name,
    description: value.description,
    color: value.color,
    sortOrder: value.sortOrder,
    isSubscribed: value.isSubscribed,
    isVisible: value.isVisible,
    isDefault: id === defaultId,
    includeInAvailability: 'all',
    defaultAlertsWithTime: value.defaultAlertsWithTime,
    defaultAlertsWithoutTime: value.defaultAlertsWithoutTime,
    timeZone: value.timeZone,
    // Access is given to a whole account, not to one calendar of it.
    shareWith: null,
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: mayWrite,
      mayWriteOwn: mayWrite,
      mayUpdatePrivate: mayWrite,
      mayRSVP: mayWrite,
      mayShare: false,
      mayAdmin: false,
      mayDelete: mayWrite,
    },
  };
}

const alerts = (value: unknown): value is Record<string, unknown> | null =>
  value === null ||
  (isPlainObject(value) && Object.values(value).every(isPlainObject));

/** Takes what a client may set from a whole calendar, or says what is wrong with it. */
function calendarValue(calendar: Record<string, unknown>): CalendarValue {
  const problems: string[] = [];
  const {
    name,
    description,
    color,
    sortOrder,
    isSubscribed,
    isVisible,
    defaultAlertsWithTime,
    defaultAlertsWithoutTime,
    timeZone,
  } = calendar;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 255) {
    problems.push('name');
  }
  if (description !== null && typeof description !== 'string') {
    problems.push('description');
  }
  if (color !== null && !(typeof color === 'string' && COLOR.test(color))) {
    problems.push('color');
  }
  if (
    typeof sortOrder !== 'number' ||
    !Number.isInteger(sortOrder) ||
    sortOrder < 0
  ) {
    problems.push('sortOrder');
  }
  if (typeof isSubscribed !== 'boolean') problems.push('isSubscribed');
  if (typeof isVisible !== 'boolean') problems.push('isVisible');
  if (!alerts(defaultAlertsWithTime)) problems.push('defaultAlertsWithTime');
  if (!alerts(defaultAlertsWithoutTime)) {
    problems.push('defaultAlertsWithoutTime');
  }
  if (
    timeZone !== null &&
    !(typeof timeZone === 'string' && isTimeZone(timeZone))
  ) {
    problems.push('timeZone');
  }
  for (const property of Object.keys(calendar)) {
    if (!CALENDAR_PROPERTIES.includes(property)) problems.push(property);
  }
  if (problems.length > 0) {
    throw invalid(problems, 'These properties are missing or not valid');
  }
  return {
    name: (name as string).trim(),
    description: description as string | null,
    color: color === null ? null : (color as string).toLowerCase(),
    sortOrder: sortOrder as number,
    isSubscribed: isSubscribed as boolean,
    isVisible: isVisible as boolean,
    defaultAlertsWithTime:
      defaultAlertsWithTime as CalendarValue['defaultAlertsWithTime'],
    defaultAlertsWithoutTime:
      defaultAlertsWithoutTime as CalendarValue['defaultAlertsWithoutTime'],
    timeZone: timeZone as string | null,
  };
}

function requireServerSet(
  given: Record<string, unknown>,
  actual: Record<string, unknown>,
): void {
  const { shareWith } = given;
  if (
    shareWith !== null &&
    !(isPlainObject(shareWith) && Object.keys(shareWith).length === 0)
  ) {
    throw new SetFailure(
      'forbidden',
      'A calendar cannot be shared on its own; the whole account is shared',
    );
  }
  const changed = [
    'id',
    'isDefault',
    'includeInAvailability',
    'myRights',
  ].filter((property) => !same(given[property], actual[property]));
  if (changed.length > 0) {
    throw invalid(changed, 'These properties are set by the server');
  }
}

const NEW_CALENDAR: CalendarValue = {
  name: '',
  description: null,
  color: null,
  sortOrder: 0,
  isSubscribed: true,
  isVisible: true,
  defaultAlertsWithTime: null,
  defaultAlertsWithoutTime: null,
  timeZone: null,
};

async function createCalendar(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  if (input['id'] !== undefined) {
    throw invalid(['id'], 'The server sets the id');
  }
  const id = generateId('ca');
  const blank = describeCalendar(ctx, id, NEW_CALENDAR, null);
  const calendar = { ...blank, ...input, id };
  requireServerSet(calendar, blank);
  const value = calendarValue(calendar);
  await commit(ctx, [
    { kind: 'create', type: CALENDAR, id, value: { ...value } },
  ]);
  // The client is told what it did not say itself.
  const described = describeCalendar(ctx, id, value, null);
  return {
    id,
    ...Object.fromEntries(
      Object.entries(described).filter(
        ([property]) => !same(input[property], described[property]),
      ),
    ),
  };
}

async function updateCalendar(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<null> {
  const [record] = await ctx.store.get(ctx.auth.accountId, CALENDAR, [id]);
  if (!record) throw new SetFailure('notFound');
  const current = describeCalendar(
    ctx,
    id,
    record.value as unknown as CalendarValue,
    await defaultCalendarId(ctx),
  );
  let next: Record<string, unknown>;
  try {
    next = applyPatch(current, patch);
  } catch (error) {
    if (error instanceof PatchError) {
      throw new SetFailure('invalidPatch', error.message);
    }
    throw error;
  }
  requireServerSet(next, current);
  const value = calendarValue(next);
  const changedProperties = Object.keys(value).filter(
    (property) =>
      !same(value[property as keyof CalendarValue], current[property]),
  );
  if (changedProperties.length === 0) return null;
  await commit(ctx, [
    {
      kind: 'update',
      type: CALENDAR,
      id,
      value: { ...value },
      expectedVersion: record.version,
      changedProperties,
    },
  ]);
  return null;
}

const eventsIn = (ctx: MethodContext, calendarId: string) =>
  ctx.store.list(ctx.auth.accountId, CALENDAR_EVENT, {
    name: 'calendar',
    value: calendarId,
  });

async function destroyCalendar(
  ctx: MethodContext,
  id: string,
  removeEvents: boolean,
): Promise<void> {
  const accountId = ctx.auth.accountId;
  const [record] = await ctx.store.get(accountId, CALENDAR, [id]);
  if (!record) throw new SetFailure('notFound');
  const events = await eventsIn(ctx, id);
  if (events.length > 0 && !removeEvents) {
    throw new SetFailure(
      'calendarHasEvent',
      'The calendar still has events in it',
    );
  }
  // An event that is in another calendar as well only leaves this one.
  const ops = events.map((event): WriteOp => {
    const remaining = Object.keys(
      event.value['calendarIds'] as Record<string, true>,
    ).filter((calendarId) => calendarId !== id);
    if (remaining.length === 0) {
      return {
        kind: 'destroy',
        type: CALENDAR_EVENT,
        id: event.id,
        expectedVersion: event.version,
      };
    }
    const value = {
      ...event.value,
      calendarIds: Object.fromEntries(
        remaining.map((calendarId) => [calendarId, true]),
      ),
    };
    return {
      kind: 'update',
      type: CALENDAR_EVENT,
      id: event.id,
      value,
      expectedVersion: event.version,
      indexes: eventIndexes(value),
      changedProperties: ['calendarIds'],
    };
  });
  for (let start = 0; start < ops.length; start += EVENTS_PER_COMMIT) {
    await commit(ctx, ops.slice(start, start + EVENTS_PER_COMMIT));
  }

  const [settings] = await ctx.store.get(accountId, SETTINGS, [SETTINGS_ID]);
  await commit(ctx, [
    { kind: 'destroy', type: CALENDAR, id, expectedVersion: record.version },
    // Nothing takes the place of a default that is gone; the client may name another.
    ...(settings?.value['defaultCalendarId'] === id
      ? [
          {
            kind: 'update',
            type: SETTINGS,
            id: SETTINGS_ID,
            value: { defaultCalendarId: null },
            expectedVersion: settings.version,
          } as const,
        ]
      : []),
  ]);
}

/**
 * Makes a calendar the default. Returns what changed for which calendar, or
 * null when nothing did: it is the default already, or does not exist.
 */
async function setDefaultCalendar(
  ctx: MethodContext,
  id: string,
): Promise<Record<string, { isDefault: boolean }> | null> {
  const accountId = ctx.auth.accountId;
  return retryOnConflict(async () => {
    const [settings] = await ctx.store.get(accountId, SETTINGS, [SETTINGS_ID]);
    const previous =
      (settings?.value['defaultCalendarId'] as string | null) ?? null;
    if (previous === id) return null;
    const calendars = await ctx.store.get(accountId, CALENDAR, [
      id,
      ...(previous === null ? [] : [previous]),
    ]);
    if (!calendars.some((calendar) => calendar.id === id)) return null;
    const value = { defaultCalendarId: id };
    await commit(ctx, [
      settings
        ? {
            kind: 'update',
            type: SETTINGS,
            id: SETTINGS_ID,
            value,
            expectedVersion: settings.version,
          }
        : { kind: 'create', type: SETTINGS, id: SETTINGS_ID, value },
      // Written as they are, so that both are reported as changed.
      ...calendars.map((calendar): WriteOp => ({
        kind: 'update',
        type: CALENDAR,
        id: calendar.id,
        value: calendar.value,
        expectedVersion: calendar.version,
        changedProperties: ['isDefault'],
      })),
    ]);
    return Object.fromEntries(
      calendars.map((calendar) => [
        calendar.id,
        { isDefault: calendar.id === id },
      ]),
    );
  });
}

/** Gives an account that has no calendar one to start with, as its default. */
export async function provisionCalendars(ctx: MethodContext): Promise<void> {
  const accountId = ctx.auth.accountId;
  if ((await ctx.store.list(accountId, CALENDAR)).length > 0) return;
  const { id } = await createCalendar(ctx, {
    name: 'Personal',
    color: '#2456c8',
    // Told half an hour before, unless an event says otherwise.
    defaultAlertsWithTime: {
      '1': {
        '@type': 'Alert',
        trigger: { '@type': 'OffsetTrigger', offset: '-PT30M' },
        action: 'display',
      },
    },
  });
  await setDefaultCalendar(ctx, id);
}

/**
 * The same for an account that is older than its calendar, asked each time a
 * server starts to be used: one small read says whether it was done already.
 */
export async function prepareCalendars(ctx: MethodContext): Promise<void> {
  const [settings] = await ctx.store.get(ctx.auth.accountId, SETTINGS, [
    SETTINGS_ID,
  ]);
  if (!settings && !ctx.isReadOnly) await provisionCalendars(ctx);
}

const CalendarSetArgumentsSchema = SetArgumentsSchema.extend({
  onDestroyRemoveEvents: z.boolean().optional(),
  onSuccessSetIsDefault: z.string().nullish(),
});

// ------------------------------------------------------------------- events

type Event = { id: string } & Record<string, unknown>;

/** What an answer to an invitation is an answer to. */
const WHEN_AND_WHERE = [
  'start',
  'duration',
  'timeZone',
  'showWithoutTime',
  'locations',
  'recurrenceRules',
  'recurrenceRule',
];

/** What is worked out from an event and never kept with it. */
const COMPUTED = ['utcStart', 'utcEnd', 'isOrigin', 'baseEventId'];

function span(value: Record<string, unknown>): { start: number; end: number } {
  const zone = (value['timeZone'] as string | null | undefined) ?? null;
  const start = zonedToUtc(String(value['start']), zone);
  const length = durationMillis(String(value['duration'] ?? 'PT0S')) ?? 0;
  return { start, end: start + length };
}

/**
 * An event as a client is given it. When it is in the world's time is only
 * said when asked for by name: it follows from the rest.
 */
function toEvent(record: StoredRecord, withUtc: boolean): Event {
  const event: Event = {
    id: record.id,
    isDraft: false,
    ...record.value,
    // Every event here was made here: none is a copy of someone else's invitation.
    isOrigin: true,
  };
  if (withUtc) {
    const { start, end } = span(record.value);
    event['utcStart'] = toUtcDate(new Date(start));
    event['utcEnd'] = toUtcDate(new Date(end));
  }
  return event;
}

/** One of the times an event that repeats is on, as an event of its own. */
function toOccurrence(
  record: StoredRecord,
  recurrenceId: string,
  withUtc: boolean,
): Event | undefined {
  const found = occurrenceAt(record.value, recurrenceId);
  if (!found) return undefined;
  return {
    isDraft: false,
    ...found.event,
    id: occurrenceId(record.id, recurrenceId),
    baseEventId: record.id,
    isOrigin: true,
    ...(withUtc
      ? {
          utcStart: toUtcDate(new Date(found.utcStart)),
          utcEnd: toUtcDate(new Date(found.utcEnd)),
        }
      : {}),
  };
}

/** A uid may be any text of any length, so it is found by a digest and then compared. */
function eventIndexes(
  value: Record<string, unknown>,
): Record<string, string[]> {
  return {
    calendar: Object.keys(value['calendarIds'] as object),
    uid: [fingerprint(String(value['uid']))],
  };
}

const text = (value: unknown, most: number) =>
  typeof value === 'string' && value.length <= most;

/** What is wrong with an event, by property. Only what this server relies on is looked at. */
export function eventProblems(event: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (event['@type'] !== 'Event') problems.push('@type');
  if (!text(event['uid'], 255) || event['uid'] === '') problems.push('uid');
  if (!text(event['title'] ?? '', 1024)) problems.push('title');
  if (!text(event['description'] ?? '', 64 * 1024))
    problems.push('description');
  if (
    typeof event['start'] !== 'string' ||
    !LOCAL_DATE_TIME.test(event['start']) ||
    Number.isNaN(Date.parse(`${event['start']}Z`))
  ) {
    problems.push('start');
  }
  if (
    event['duration'] !== undefined &&
    (typeof event['duration'] !== 'string' ||
      durationMillis(event['duration']) === null)
  ) {
    problems.push('duration');
  }
  const zone = event['timeZone'];
  if (
    zone !== undefined &&
    zone !== null &&
    !(typeof zone === 'string' && isTimeZone(zone))
  ) {
    problems.push('timeZone');
  }
  for (const flag of ['showWithoutTime', 'isDraft', 'useDefaultAlerts']) {
    if (event[flag] !== undefined && typeof event[flag] !== 'boolean') {
      problems.push(flag);
    }
  }
  for (const map of [
    'locations',
    'virtualLocations',
    'participants',
    'alerts',
  ]) {
    const value = event[map];
    if (
      value !== undefined &&
      value !== null &&
      !(isPlainObject(value) && Object.values(value).every(isPlainObject))
    ) {
      problems.push(map);
    }
  }
  const rules = event['recurrenceRules'];
  if (
    rules !== undefined &&
    rules !== null &&
    !(Array.isArray(rules) && rules.every(isPlainObject))
  ) {
    problems.push('recurrenceRules');
  }
  if (
    event['recurrenceRule'] !== undefined &&
    event['recurrenceRule'] !== null &&
    !isPlainObject(event['recurrenceRule'])
  ) {
    problems.push('recurrenceRule');
  }
  const overrides = event['recurrenceOverrides'];
  if (
    overrides !== undefined &&
    overrides !== null &&
    !(
      isPlainObject(overrides) &&
      Object.entries(overrides).every(
        ([when, patch]) => LOCAL_DATE_TIME.test(when) && isPlainObject(patch),
      )
    )
  ) {
    problems.push('recurrenceOverrides');
  }
  for (const property of COMPUTED) {
    if (event[property] !== undefined) problems.push(property);
  }
  return problems;
}

async function checkEvent(
  ctx: MethodContext,
  event: Record<string, unknown>,
): Promise<void> {
  const problems = eventProblems(event);
  const calendars = event['calendarIds'];
  if (
    !isPlainObject(calendars) ||
    Object.keys(calendars).length === 0 ||
    !Object.values(calendars).every((value) => value === true)
  ) {
    problems.push('calendarIds');
  } else {
    const ids = Object.keys(calendars);
    const found = await ctx.store.get(ctx.auth.accountId, CALENDAR, ids);
    if (found.length !== ids.length) problems.push('calendarIds');
  }
  if (problems.length > 0) {
    throw invalid(
      [...new Set(problems)],
      'These properties are missing or not valid',
    );
  }
  if (encoder.encode(JSON.stringify(event)).length > MAX_EVENT_OCTETS) {
    throw new SetFailure('tooLarge', 'The event is too large');
  }
}

function resolveCalendarIds(ctx: MethodContext, calendars: unknown): unknown {
  if (!isPlainObject(calendars)) return calendars;
  return Object.fromEntries(
    Object.entries(calendars).map(([id, value]) => [
      resolveCreationReference(ctx, id) ?? id,
      value,
    ]),
  );
}

async function createEvent(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<Event> {
  if (input['id'] !== undefined) {
    throw invalid(['id'], 'The server sets the id');
  }
  const now = toUtcDate(new Date());
  // What an event must have and the client left out is the server's to give.
  const serverSet: Record<string, unknown> = {};
  const defaults = {
    '@type': 'Event',
    uid: `${crypto.randomUUID()}`,
    created: now,
    updated: now,
    sequence: 0,
  };
  for (const [property, value] of Object.entries(defaults)) {
    if (input[property] === undefined) serverSet[property] = value;
  }
  const event = {
    ...input,
    ...serverSet,
    calendarIds: resolveCalendarIds(ctx, input['calendarIds']),
  };
  await checkEvent(ctx, event);
  const id = generateId('ev');
  await commit(ctx, [
    {
      kind: 'create',
      type: CALENDAR_EVENT,
      id,
      value: event,
      indexes: eventIndexes(event),
    },
  ]);
  return { id, ...serverSet };
}

async function updateEvent(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const one = parseOccurrenceId(id);
  if (one) {
    await overrideOccurrence(ctx, one, patch);
    return null;
  }
  const [record] = await ctx.store.get(ctx.auth.accountId, CALENDAR_EVENT, [
    id,
  ]);
  if (!record) throw new SetFailure('notFound');
  const resolved = Object.fromEntries(
    Object.entries(patch).map(([path, value]) => {
      const [property, key, ...rest] = path.split('/');
      if (property !== 'calendarIds') return [path, value];
      if (key === undefined) return [path, resolveCalendarIds(ctx, value)];
      const calendarId = resolveCreationReference(ctx, key) ?? key;
      return [[property, calendarId, ...rest].join('/'), value];
    }),
  );
  const fixed = Object.keys(resolved)
    .map((path) => path.split('/')[0] ?? path)
    .filter((property) => property === 'id' || COMPUTED.includes(property));
  if (fixed.length > 0) {
    throw invalid(
      [...new Set(fixed)],
      'These properties are set by the server',
    );
  }
  let next: Record<string, unknown>;
  try {
    next = applyPatch(record.value, resolved);
  } catch (error) {
    if (error instanceof PatchError) {
      throw new SetFailure('invalidPatch', error.message);
    }
    throw error;
  }
  // An event has no property whose value is null but its time zone: to set another to null is to remove it.
  for (const [property, value] of Object.entries(next)) {
    if (value === null && property !== 'timeZone') delete next[property];
  }
  const changedProperties = [
    ...new Set(Object.keys(resolved).map((path) => path.split('/')[0] ?? path)),
  ].filter((property) => !same(next[property], record.value[property]));
  if (changedProperties.length === 0) return null;

  // Moved as a whole, an event that repeats takes along what was changed for
  // one of its times: each is known by when the rule put it, which is now later.
  const moved =
    Date.parse(`${String(next['start'])}Z`) -
    Date.parse(`${String(record.value['start'])}Z`);
  if (
    moved !== 0 &&
    !Number.isNaN(moved) &&
    !changedProperties.includes('recurrenceOverrides') &&
    isPlainObject(next['recurrenceOverrides'])
  ) {
    next['recurrenceOverrides'] = Object.fromEntries(
      Object.entries(next['recurrenceOverrides']).map(([when, change]) => [
        LOCAL_DATE_TIME.test(when)
          ? new Date(Date.parse(`${when}Z`) + moved).toISOString().slice(0, 19)
          : when,
        change,
      ]),
    );
    changedProperties.push('recurrenceOverrides');
  }

  const serverSet: Record<string, unknown> = {};
  if (!changedProperties.includes('updated')) {
    serverSet['updated'] = next['updated'] = toUtcDate(new Date());
    changedProperties.push('updated');
  }
  // When or where it is has changed: those who answered answered to something
  // else, which a higher number tells their calendars (RFC 5546 §2.1.4).
  if (
    WHEN_AND_WHERE.some((property) => changedProperties.includes(property)) &&
    !changedProperties.includes('sequence')
  ) {
    serverSet['sequence'] = next['sequence'] =
      Number(record.value['sequence'] ?? 0) + 1;
    changedProperties.push('sequence');
  }
  await checkEvent(ctx, next);
  await commit(ctx, [
    {
      kind: 'update',
      type: CALENDAR_EVENT,
      id,
      value: next,
      expectedVersion: record.version,
      indexes: eventIndexes(next),
      changedProperties,
    },
  ]);
  return serverSet;
}

/**
 * Changes one of the times an event that repeats is on, which is kept with
 * the event as what is different that once. `change` null takes it out.
 */
async function overrideOccurrence(
  ctx: MethodContext,
  one: { eventId: string; recurrenceId: string },
  change: Record<string, unknown> | null,
): Promise<void> {
  const [record] = await ctx.store.get(ctx.auth.accountId, CALENDAR_EVENT, [
    one.eventId,
  ]);
  if (!record || !occurrenceAt(record.value, one.recurrenceId)) {
    throw new SetFailure('notFound');
  }
  const overrides = isPlainObject(record.value['recurrenceOverrides'])
    ? record.value['recurrenceOverrides']
    : {};
  const before = overrides[one.recurrenceId];
  let next: Record<string, unknown> = { excluded: true };
  if (change !== null) {
    const fixed = Object.keys(change)
      .map((path) => path.split('/')[0] ?? path)
      .filter(
        (property) =>
          property === 'id' ||
          COMPUTED.includes(property) ||
          NOT_FOR_ONE.includes(property),
      );
    if (fixed.length > 0) {
      throw invalid(
        [...new Set(fixed)],
        'These cannot be different for one occurrence of an event',
      );
    }
    next = { ...(isPlainObject(before) ? before : {}), ...change };
  }
  await updateEvent(ctx, one.eventId, {
    recurrenceOverrides: { ...overrides, [one.recurrenceId]: next },
  });
}

async function destroyEvent(ctx: MethodContext, id: string): Promise<void> {
  const one = parseOccurrenceId(id);
  if (one) return overrideOccurrence(ctx, one, null);
  const [record] = await ctx.store.get(ctx.auth.accountId, CALENDAR_EVENT, [
    id,
  ]);
  if (!record) throw new SetFailure('notFound');
  await commit(ctx, [
    {
      kind: 'destroy',
      type: CALENDAR_EVENT,
      id,
      expectedVersion: record.version,
    },
  ]);
}

// ------------------------------------------------------------------ queries

const words = (value: string): string[] =>
  value.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word asked for is somewhere in the texts, in any order. */
function textMatches(texts: readonly unknown[], query: string): boolean {
  const all = texts
    .filter((each): each is string => typeof each === 'string')
    .join('\n')
    .toLowerCase();
  return words(query).every((word) => all.includes(word));
}

const placeNames = (event: Event): unknown[] =>
  isPlainObject(event['locations'])
    ? Object.values(event['locations']).map((place) =>
        isPlainObject(place) ? place['name'] : undefined,
      )
    : [];

const peopleNames = (event: Event): unknown[] =>
  isPlainObject(event['participants'])
    ? Object.values(event['participants']).flatMap((person) =>
        isPlainObject(person) ? [person['name'], person['email']] : [],
      )
    : [];

const isString = (value: unknown) => typeof value === 'string';
const isLocal = (value: unknown) =>
  typeof value === 'string' && LOCAL_DATE_TIME.test(value);

/** What a filter may ask, and whether an event answers to it. `zone` is the one times are given in. */
const conditions = (
  zone: string | null,
): Record<
  string,
  {
    valid(value: unknown): boolean;
    matches(event: Event, value: unknown): boolean;
  }
> => ({
  inCalendar: {
    valid: isString,
    matches: (event, value) =>
      (event['calendarIds'] as Record<string, true>)[value as string] === true,
  },
  // An event is after a time when it ends after it, and before one when it starts before it.
  after: {
    valid: isLocal,
    matches: (event, value) =>
      span(event).end > zonedToUtc(value as string, zone),
  },
  before: {
    valid: isLocal,
    matches: (event, value) =>
      span(event).start < zonedToUtc(value as string, zone),
  },
  text: {
    valid: isString,
    matches: (event, value) =>
      textMatches(
        [
          event['title'],
          event['description'],
          ...placeNames(event),
          ...peopleNames(event),
        ],
        value as string,
      ),
  },
  title: {
    valid: isString,
    matches: (event, value) => textMatches([event['title']], value as string),
  },
  description: {
    valid: isString,
    matches: (event, value) =>
      textMatches([event['description']], value as string),
  },
  location: {
    valid: isString,
    matches: (event, value) => textMatches(placeNames(event), value as string),
  },
  attendee: {
    valid: isString,
    matches: (event, value) => textMatches(peopleNames(event), value as string),
  },
  uid: {
    valid: isString,
    matches: (event, value) => event['uid'] === value,
  },
});

const eventQuerySpec = (zone: string | null): QuerySpec<Event> => {
  const known = conditions(zone);
  return {
    validateCondition(condition) {
      for (const [key, value] of Object.entries(condition)) {
        if (!known[key]?.valid(value)) {
          throw new MethodError(
            'invalidArguments',
            `Invalid CalendarEvent filter property "${key}"`,
          );
        }
      }
    },
    matches: (event, condition) =>
      Object.entries(condition).every(([key, value]) =>
        known[key]?.matches(event, value),
      ),
    comparator(comparator: Comparator): CompareFn<Event> {
      const { property } = comparator;
      if (property === 'start') {
        return (a, b) => span(a).start - span(b).start;
      }
      if (property === 'created' || property === 'updated') {
        const time = (value: unknown) => Date.parse(String(value)) || 0;
        return (a, b) => time(a[property]) - time(b[property]);
      }
      if (property === 'uid') {
        return (a, b) =>
          compareStrings(
            String(a['uid']),
            String(b['uid']),
            comparator.collation,
          );
      }
      throw new MethodError(
        'unsupportedSort',
        `Events cannot be sorted by "${property}"`,
      );
    },
  };
};

const EventQueryArgumentsSchema = QueryArgumentsSchema.extend({
  /** The zone `after` and `before` are given in. Without one they are taken as UTC. */
  timeZone: z.string().nullish(),
  expandRecurrences: z.boolean().optional(),
});

const EventQueryChangesArgumentsSchema = QueryChangesArgumentsSchema.extend({
  timeZone: z.string().nullish(),
});

/** How far ahead an event that repeats is looked for when a filter says from when and not until when. */
const LOOK_AHEAD = 5 * 366 * 86_400_000;

async function queryEvents(
  ctx: MethodContext,
  args: {
    filter?: Record<string, unknown> | null | undefined;
    sort?: Comparator[] | null | undefined;
    timeZone?: string | null | undefined;
  },
  /** Each time an event that repeats is on, in place of the event. */
  expanded = false,
): Promise<string[]> {
  const zone = args.timeZone ?? null;
  if (zone !== null && !isTimeZone(zone)) {
    throw new MethodError('invalidArguments', 'Unknown time zone');
  }
  const [calendarId] = requiredConditionValues(args.filter, 'inCalendar');
  const [after] = requiredConditionValues(args.filter, 'after');
  const [before] = requiredConditionValues(args.filter, 'before');
  if (expanded && !(isLocal(after) && isLocal(before))) {
    throw new MethodError(
      'invalidArguments',
      'To expand recurrences the filter has to say after when and before when',
    );
  }
  const records =
    typeof calendarId === 'string'
      ? await eventsIn(ctx, calendarId)
      : await ctx.store.list(ctx.auth.accountId, CALENDAR_EVENT);
  /** The event each thing looked at is, or is one of the times of. */
  const eventOf = new Map<string, string>();
  const items = records.flatMap((record): Event[] => {
    const whole = [{ id: record.id, ...record.value }];
    eventOf.set(record.id, record.id);
    // With no time asked about, an event that repeats is found by itself.
    if (!repeats(record.value) || !(isLocal(after) || isLocal(before))) {
      return whole;
    }
    const start = span(record.value).start;
    const from = isLocal(after) ? zonedToUtc(after as string, zone) : start;
    const to = isLocal(before)
      ? zonedToUtc(before as string, zone)
      : Math.max(from, start) + LOOK_AHEAD;
    return expand(record.value, from, to).map((each) => {
      const id = occurrenceId(record.id, each.recurrenceId);
      eventOf.set(id, record.id);
      return { ...each.event, id };
    });
  });
  const found = filterAndSort(
    items,
    args.filter,
    args.sort,
    eventQuerySpec(zone),
  ).map(({ id }) => id);
  // Not expanded, an event is there once however often it is on in the time asked about.
  return expanded
    ? found.map((id) => (repeatsId(id, eventOf) ? id : (eventOf.get(id) ?? id)))
    : [...new Set(found.map((id) => eventOf.get(id) ?? id))];
}

/** Whether an id found is one of the times of an event, and not the event. */
const repeatsId = (id: string, eventOf: ReadonlyMap<string, string>) =>
  eventOf.get(id) !== id;

const EventCopyArgumentsSchema = z.strictObject({
  fromAccountId: z.string(),
  ifFromInState: z.string().nullish(),
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())),
  onSuccessDestroyOriginal: z.boolean().optional(),
  destroyFromIfInState: z.string().nullish(),
});

const AvailabilityArgumentsSchema = z.strictObject({
  accountId: z.string().optional(),
  id: z.string(),
  utcStart: z.string(),
  utcEnd: z.string(),
  showDetails: z.boolean().optional(),
  eventProperties: z.array(z.string()).nullish(),
});

const EventSetArgumentsSchema = SetArgumentsSchema.extend({
  /** Tells the people on each event what was done to it, by mail. */
  sendSchedulingMessages: z.boolean().optional(),
});

const EventParseArgumentsSchema = z.strictObject({
  accountId: z.string(),
  blobIds: z.array(z.string()).max(20),
  properties: z.array(z.string()).nullish(),
});

/** A calendar file larger than this is not read: an invitation is a few lines. */
const MAX_CALENDAR_OCTETS = 1024 * 1024;

const eventSetSpec = {
  type: CALENDAR_EVENT,
  create: createEvent,
  update: updateEvent,
  destroy: destroyEvent,
};

export const calendarMethods: Record<string, MethodHandler> = {
  'Calendar/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, CALENDAR_PROPERTIES);
    const { state, records, notFound } = await loadForGet(
      ctx,
      CALENDAR,
      args.ids,
    );
    const defaultId = await defaultCalendarId(ctx);
    return {
      accountId,
      state,
      list: records.map((record) =>
        pick(
          describeCalendar(
            ctx,
            record.id,
            record.value as unknown as CalendarValue,
            defaultId,
          ),
          properties,
        ),
      ),
      notFound,
    };
  },

  'Calendar/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, CALENDAR, rawArgs)),
  }),

  'Calendar/set': async (rawArgs, ctx) => {
    const args = parseArguments(CalendarSetArgumentsSchema, rawArgs);
    const response = await standardSet(
      ctx,
      {
        type: CALENDAR,
        create: createCalendar,
        update: updateCalendar,
        destroy: (context, id) =>
          destroyCalendar(context, id, args.onDestroyRemoveEvents ?? false),
      },
      args,
    );
    const wanted = args.onSuccessSetIsDefault;
    const succeeded =
      !response.notCreated && !response.notUpdated && !response.notDestroyed;
    const id =
      typeof wanted === 'string' && succeeded
        ? resolveCreationReference(ctx, wanted)
        : undefined;
    const changed = id === undefined ? null : await setDefaultCalendar(ctx, id);
    if (!changed) return { ...response };

    const created = { ...response.created };
    const updated = { ...response.updated };
    for (const [calendarId, change] of Object.entries(changed)) {
      const creationId = Object.keys(created).find(
        (key) => created[key]?.['id'] === calendarId,
      );
      if (creationId !== undefined) {
        created[creationId] = { ...created[creationId], ...change };
      } else {
        updated[calendarId] = { ...updated[calendarId], ...change };
      }
    }
    return {
      ...response,
      newState: await ctx.store.getState(args.accountId, CALENDAR),
      created: Object.keys(created).length > 0 ? created : null,
      updated,
    };
  },

  'CalendarEvent/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    // An occurrence is asked for by an id made of its event's and its time.
    const ones = (args.ids ?? []).flatMap((id) => {
      const parsed = parseOccurrenceId(id);
      return parsed ? [{ id, ...parsed }] : [];
    });
    const { state, records, notFound } = await loadForGet(
      ctx,
      CALENDAR_EVENT,
      args.ids
        ? args.ids.filter((id) => !ones.some((one) => one.id === id))
        : args.ids,
    );
    const properties = args.properties
      ? [...new Set(['id', ...args.properties])]
      : null;
    const withUtc =
      properties?.some((property) => property.startsWith('utc')) ?? false;
    const list = records.map((record) => toEvent(record, withUtc));
    if (ones.length > 0) {
      const of = new Map(
        (
          await ctx.store.get(accountId, CALENDAR_EVENT, [
            ...new Set(ones.map((one) => one.eventId)),
          ])
        ).map((record) => [record.id, record]),
      );
      for (const one of ones) {
        const record = of.get(one.eventId);
        const found = record
          ? toOccurrence(record, one.recurrenceId, withUtc)
          : undefined;
        if (found) list.push(found);
        else notFound.push(one.id);
      }
    }
    return {
      accountId,
      state,
      list: list.map((event) => (properties ? pick(event, properties) : event)),
      notFound,
    };
  },

  'CalendarEvent/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, CALENDAR_EVENT, rawArgs)),
  }),

  'CalendarEvent/query': async (rawArgs, ctx) => {
    const args = parseArguments(EventQueryArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const expanded = args.expandRecurrences === true;
    const ids = await queryEvents(ctx, args, expanded);
    const state = await ctx.store.getState(accountId, CALENDAR_EVENT);
    return {
      ...paginate(ctx, ids, args, state),
      // What changed among occurrences is not something this server can say.
      ...(expanded ? { canCalculateChanges: false } : {}),
    };
  },

  'CalendarEvent/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(EventQueryChangesArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, CALENDAR_EVENT);
    const changes = await changesSince(
      ctx,
      CALENDAR_EVENT,
      args.sinceQueryState,
    );
    const ids = await queryEvents(ctx, args);
    return { ...queryChanges(ctx, ids, changes, [], args, state) };
  },

  'CalendarEvent/set': async (rawArgs, ctx) => {
    const args = parseArguments(EventSetArgumentsSchema, rawArgs);
    const tell =
      args.sendSchedulingMessages === true
        ? ctx.calendars.scheduling
        : undefined;
    if (!tell) return { ...(await standardSet(ctx, eventSetSpec, args)) };

    // Each event as it was and as it is, for what to tell the people on it.
    const changes: Array<{ before?: Event; after?: Event }> = [];
    const whole = async (id: string) => {
      const [record] = await ctx.store.get(ctx.auth.accountId, CALENDAR_EVENT, [
        id,
      ]);
      return record ? ({ ...record.value } as Event) : undefined;
    };
    const kept = (before?: Event, after?: Event) =>
      changes.push({
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      });
    const response = await standardSet(
      ctx,
      {
        type: CALENDAR_EVENT,
        create: async (context, input) => {
          const made = await createEvent(context, input);
          kept(undefined, await whole(made.id));
          return made;
        },
        update: async (context, id, patch) => {
          const eventId = parseOccurrenceId(id)?.eventId ?? id;
          const before = await whole(eventId);
          const changed = await updateEvent(context, id, patch);
          kept(before, await whole(eventId));
          return changed;
        },
        destroy: async (context, id) => {
          const eventId = parseOccurrenceId(id)?.eventId ?? id;
          const before = await whole(eventId);
          await destroyEvent(context, id);
          kept(before, await whole(eventId));
        },
      },
      args,
    );
    if (changes.length > 0) {
      const addresses = await tell.addresses(ctx);
      for (const { before, after } of changes) {
        for (const message of messagesFor(before, after, addresses)) {
          try {
            await tell.send(ctx, message);
          } catch (error) {
            // The event is kept: not having been able to tell of it does not undo it.
            ctx.calendars.onSchedulingError?.(error);
          }
        }
      }
    }
    return { ...response };
  },

  /** Reads events out of files that other calendars write (iCalendar), without keeping them. */
  'CalendarEvent/parse': async (rawArgs, ctx) => {
    const args = parseArguments(EventParseArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const parsed: Record<string, Record<string, unknown>> = {};
    const notParsable: string[] = [];
    const notFound: string[] = [];
    for (const blobId of args.blobIds) {
      const data = await ctx.readBlob(blobId);
      if (!data) {
        notFound.push(blobId);
        continue;
      }
      const read =
        data.length > MAX_CALENDAR_OCTETS
          ? { method: null, events: [] }
          : fromICalendar(new TextDecoder().decode(data));
      const [event] = read.events;
      if (!event) {
        notParsable.push(blobId);
        continue;
      }
      const whole: Event = {
        ...event,
        // What the file is for: an invitation, an answer, a cancellation.
        ...(read.method ? { method: read.method.toLowerCase() } : {}),
        id: blobId,
        // When it is in the world's time, for whoever shows it without knowing the zones.
        utcStart: toUtcDate(new Date(span(event).start)),
        utcEnd: toUtcDate(new Date(span(event).end)),
      };
      parsed[blobId] = args.properties
        ? pick(whole, [...new Set(['id', ...args.properties])])
        : whole;
    }
    return {
      accountId,
      parsed: Object.keys(parsed).length > 0 ? parsed : null,
      notParsable: notParsable.length > 0 ? notParsable : null,
      notFound: notFound.length > 0 ? notFound : null,
    };
  },

  'CalendarEvent/copy': async (rawArgs, ctx) => {
    const args = parseArguments(EventCopyArgumentsSchema, rawArgs);
    const { from, to } = requireCopyAccounts(
      ctx,
      args.fromAccountId,
      args.accountId,
    );
    if (args.onSuccessDestroyOriginal && from.isReadOnly) {
      throw new MethodError(
        'accountReadOnly',
        'The originals cannot be destroyed: their account is read-only',
      );
    }
    const create = Object.entries(args.create);
    if (create.length > ctx.limits.maxObjectsInSet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInSet} events may be copied in one call`,
      );
    }
    const oldState = await to.store.getState(args.accountId, CALENDAR_EVENT);
    if (
      (args.ifInState !== null &&
        args.ifInState !== undefined &&
        args.ifInState !== oldState) ||
      (args.ifFromInState !== null &&
        args.ifFromInState !== undefined &&
        args.ifFromInState !==
          (await from.store.getState(args.fromAccountId, CALENDAR_EVENT)))
    ) {
      throw new MethodError('stateMismatch');
    }

    const created: Record<string, { id: string }> = {};
    const notCreated: Record<string, SetError> = {};
    const copiedFrom: string[] = [];
    for (const [creationId, input] of create) {
      try {
        const { id: sourceId, ...changes } = input;
        if (typeof sourceId !== 'string') {
          throw invalid(['id'], 'id must be the id of the event to copy');
        }
        const [source] = await from.store.get(
          args.fromAccountId,
          CALENDAR_EVENT,
          [sourceId],
        );
        if (!source) throw new SetFailure('notFound');
        // It is the same event in another account: it keeps its uid, and all else it had.
        const made = await createEvent(to, { ...source.value, ...changes });
        created[creationId] = { id: made.id };
        to.createdIds.set(creationId, made.id);
        copiedFrom.push(source.id);
      } catch (error) {
        if (!(error instanceof SetFailure)) throw error;
        notCreated[creationId] = error.error;
      }
    }

    if (args.onSuccessDestroyOriginal && copiedFrom.length > 0) {
      ctx.extraResponses.push([
        'CalendarEvent/set',
        {
          ...(await standardSet(from, eventSetSpec, {
            accountId: args.fromAccountId,
            ifInState: args.destroyFromIfInState,
            destroy: copiedFrom,
          })),
        },
      ]);
    }

    return {
      fromAccountId: args.fromAccountId,
      accountId: args.accountId,
      oldState,
      newState: await to.store.getState(args.accountId, CALENDAR_EVENT),
      created: Object.keys(created).length > 0 ? created : null,
      notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    };
  },

  /**
   * When someone is busy, from the calendars of the account that is theirs.
   * What they are busy with is not said: only when.
   */
  'Principal/getAvailability': async (rawArgs, ctx) => {
    const args = parseArguments(AvailabilityArgumentsSchema, rawArgs);
    if (args.accountId !== undefined) requireAccount(ctx, args.accountId);
    const from = Date.parse(args.utcStart);
    const to = Date.parse(args.utcEnd);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
      throw new MethodError(
        'invalidArguments',
        'utcStart and utcEnd must be two moments, one after the other',
      );
    }
    // A principal is whoever owns an account the user may use, and goes by its id.
    const theirs = Object.prototype.hasOwnProperty.call(ctx.accounts(), args.id)
      ? args.id === ctx.auth.accountId
        ? ctx
        : ctx.forAccount(args.id)
      : undefined;
    if (!theirs) {
      throw new MethodError('invalidArguments', 'There is no such principal');
    }
    const records = await theirs.store.list(args.id, CALENDAR_EVENT);
    const list = records
      .flatMap((record) => expand(record.value, from, to))
      // What is marked as leaving the time free, or was called off, takes none of it.
      .filter(
        ({ event }) =>
          event['freeBusyStatus'] !== 'free' && event['status'] !== 'cancelled',
      )
      .sort((a, b) => a.utcStart - b.utcStart)
      .map((each) => ({
        utcStart: toUtcDate(new Date(each.utcStart)),
        utcEnd: toUtcDate(new Date(each.utcEnd)),
        busyStatus:
          each.event['status'] === 'tentative' ? 'tentative' : 'confirmed',
        event: null,
      }));
    return { list };
  },
};

const ProposalSendArgumentsSchema = z.strictObject({
  accountId: z.string(),
  /** The event the account was invited to. */
  eventId: z.string(),
  /** When it would be instead: on the wall of `timeZone`, or of the event's own. */
  start: z.string().regex(LOCAL_DATE_TIME),
  duration: z.string().optional(),
  timeZone: z.string().nullish(),
  comment: z.string().max(1000).optional(),
});

const ProposalDeclineArgumentsSchema = z.strictObject({
  accountId: z.string(),
  /** The event, which is the account's own. */
  eventId: z.string(),
  /** Whoever suggested another time for it. */
  to: z.string(),
});

async function proposalParties(ctx: MethodContext, eventId: string) {
  const tell = ctx.calendars.scheduling;
  if (!tell) {
    throw new MethodError(
      'invalidArguments',
      'This server has no way to send mail',
    );
  }
  const [record] = await ctx.store.get(ctx.auth.accountId, CALENDAR_EVENT, [
    eventId,
  ]);
  if (!record) throw new MethodError('invalidArguments', 'No such event');
  const own = await tell.addresses(ctx);
  const mine = new Map(own.map((each) => [each.email.toLowerCase(), each]));
  return {
    tell,
    event: record.value,
    mine,
    organizer: organizerOf(record.value),
  };
}

/**
 * Suggesting another time (RFC 5546 calls it a counter-proposal). Not part of
 * JMAP for Calendars, which has the invitation and the answer: these are
 * under a capability of this project's.
 */
export const proposalMethods: Record<string, MethodHandler> = {
  /** Someone who was invited suggests another time to whoever invited them. Nothing is changed by it. */
  'CalendarProposal/send': async (rawArgs, ctx) => {
    const args = parseArguments(ProposalSendArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const { tell, event, mine, organizer } = await proposalParties(
      ctx,
      args.eventId,
    );
    const me = attendeesOf(event)
      .map((each) => mine.get(each.email))
      .find(Boolean);
    if (organizer === null || mine.has(organizer) || !me) {
      throw new MethodError(
        'invalidArguments',
        'Another time is suggested for an event one was invited to',
      );
    }
    const zone =
      args.timeZone === undefined
        ? ((event['timeZone'] as string | null | undefined) ?? null)
        : args.timeZone;
    if (
      (zone !== null && !isTimeZone(zone)) ||
      (args.duration !== undefined && durationMillis(args.duration) === null)
    ) {
      throw new MethodError('invalidArguments', 'Not a time');
    }
    const suggested = {
      ...event,
      start: args.start,
      timeZone: zone,
      ...(args.duration === undefined ? {} : { duration: args.duration }),
    };
    // Said of the event itself, whatever was changed for some of its times.
    delete (suggested as Record<string, unknown>)['recurrenceOverrides'];
    const title = String(event['title'] ?? '') || '(no title)';
    await tell.send(ctx, {
      from: me,
      to: [organizer],
      subject: `Another time suggested: ${title}`,
      text: [
        `${me.name || me.email} suggests another time.`,
        '',
        title,
        `Suggested: ${whenText(suggested)}`,
        `As it stands: ${whenText(event)}`,
        ...(args.comment?.trim() ? ['', args.comment.trim()] : []),
        '',
      ].join('\n'),
      method: 'COUNTER',
      calendar: toICalendar(suggested, {
        method: 'COUNTER',
        attendee: me.email,
        ...(args.comment ? { comment: args.comment } : {}),
      }),
    });
    return { accountId, sent: true };
  },

  /** Whoever invited says the event stays when it is, to someone who suggested another time. */
  'CalendarProposal/decline': async (rawArgs, ctx) => {
    const args = parseArguments(ProposalDeclineArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const { tell, event, mine, organizer } = await proposalParties(
      ctx,
      args.eventId,
    );
    const to = args.to.trim().toLowerCase();
    const from = organizer === null ? undefined : mine.get(organizer);
    if (!from || !attendeesOf(event).some((each) => each.email === to)) {
      throw new MethodError(
        'invalidArguments',
        'A suggestion is answered by whoever the event is from, to someone invited to it',
      );
    }
    const title = String(event['title'] ?? '') || '(no title)';
    await tell.send(ctx, {
      from,
      to: [to],
      subject: `Time kept: ${title}`,
      text: [
        `${from.name || from.email} is keeping the time of this event.`,
        '',
        title,
        `When: ${whenText(event)}`,
        '',
      ].join('\n'),
      method: 'DECLINECOUNTER',
      calendar: toICalendar(event, { method: 'DECLINECOUNTER', attendee: to }),
    });
    return { accountId, sent: true };
  },
};

/** An answer someone gave, as this server keeps it. */
const ANSWERED = ['accepted', 'declined', 'tentative'];

/**
 * Takes in what someone else's calendar says of an event the account has: an
 * answer to an invitation of its own, which is noted on the event, or word
 * that an event it was invited to is off. `sender` is who the message is
 * from: nobody answers for somebody else, and nobody calls off what is not
 * theirs. Returns what was done, or null when it called for nothing.
 */
export async function applySchedulingMessage(
  ctx: MethodContext,
  calendar: string,
  sender: string,
): Promise<'answered' | 'cancelled' | null> {
  if (calendar.length > MAX_CALENDAR_OCTETS) return null;
  const from = sender.trim().toLowerCase();
  const { method, events } = fromICalendar(calendar);
  if (method !== 'REPLY' && method !== 'CANCEL') return null;
  let done: 'answered' | 'cancelled' | null = null;
  for (const said of events) {
    // What is said of one time of an event that repeats is left for whoever reads the message.
    if (said['recurrenceId'] !== undefined) continue;
    const records = await ctx.store.list(ctx.auth.accountId, CALENDAR_EVENT, {
      name: 'uid',
      value: fingerprint(String(said['uid'])),
    });
    const record = records.find((each) => each.value['uid'] === said['uid']);
    if (!record) continue;
    // Older than what is kept: it answers to an event that has since changed.
    if (Number(said['sequence'] ?? 0) < Number(record.value['sequence'] ?? 0)) {
      continue;
    }
    if (method === 'CANCEL') {
      if (organizerOf(record.value) !== from) continue;
      if (record.value['status'] === 'cancelled') continue;
      await updateEvent(ctx, record.id, { status: 'cancelled' });
      done = 'cancelled';
      continue;
    }
    const theirs = Object.values(
      (said['participants'] as Record<string, Event> | undefined) ?? {},
    ).find((each) => each['email'] === from);
    const status = String(theirs?.['participationStatus'] ?? '');
    if (!ANSWERED.includes(status)) continue;
    const key = Object.entries(
      (record.value['participants'] as Record<string, Event> | undefined) ?? {},
    ).find(([, each]) => {
      const imip = isPlainObject(each['sendTo']) ? each['sendTo']['imip'] : '';
      return (
        String(each['email'] ?? '').toLowerCase() === from ||
        String(imip)
          .replace(/^mailto:/i, '')
          .toLowerCase() === from
      );
    })?.[0];
    if (key === undefined) continue;
    await updateEvent(ctx, record.id, {
      [`participants/${key}/participationStatus`]: status,
    });
    done = 'answered';
  }
  return done;
}
