import { commit, type MethodContext } from '@mailless/jmap-engine';
import { expand } from './recurrence.js';
import { durationMillis } from './time.js';

/*
 * Reminders. An event says when it wants to be announced: so long before it
 * starts, or at a moment, as its own alerts or as those of its calendar. A
 * server cannot ring; what it can do is say, when asked, which reminders
 * have come due since it last said, and when the next one will. Whoever
 * hosts it asks at that moment, and tells the account's devices.
 */

export const CALENDAR_EVENT = 'CalendarEvent';
const CALENDAR = 'Calendar';
/** How far the reminders of an account have been told of. Nothing a client sees. */
const ALERT_STATE = 'CalendarAlertState';
const STATE_ID = 'state';

/** A reminder that has come due: which event, and when that is. */
export interface CalendarAlert {
  /** The event, or the one of its times this is about. */
  eventId: string;
  title: string;
  utcStart: string;
  utcEnd: string;
  showWithoutTime: boolean;
  /** Where, when the event says. */
  location: string | null;
  /** When the reminder was due. */
  at: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** When each alert of an occurrence goes off, in milliseconds. */
function triggers(alerts: unknown, utcStart: number, utcEnd: number): number[] {
  if (!isObject(alerts)) return [];
  return Object.values(alerts).flatMap((alert) => {
    if (!isObject(alert) || !isObject(alert['trigger'])) return [];
    // Told once it was seen to on one device, it is not told again.
    if (alert['acknowledged'] !== undefined) return [];
    const trigger = alert['trigger'];
    if (typeof trigger['when'] === 'string') {
      const when = Date.parse(trigger['when']);
      return Number.isNaN(when) ? [] : [when];
    }
    const offset = String(trigger['offset'] ?? '');
    const sign = offset.startsWith('-') ? -1 : 1;
    const length = durationMillis(offset.replace(/^[+-]/, ''));
    if (length === null) return [];
    return [
      (trigger['relativeTo'] === 'end' ? utcEnd : utcStart) + sign * length,
    ];
  });
}

/** The longest any reminder is set before its event, for how far ahead to look for events. */
const FURTHEST = 35 * 86_400_000;

/** The reminders that go off in a span of time: after `from`, and not after `to`. */
async function alertsBetween(
  ctx: MethodContext,
  from: number,
  to: number,
): Promise<Array<CalendarAlert & { time: number }>> {
  const accountId = ctx.auth.accountId;
  const calendars = new Map(
    (await ctx.store.list(accountId, CALENDAR)).map((record) => [
      record.id,
      record.value,
    ]),
  );
  const found: Array<CalendarAlert & { time: number }> = [];
  for (const record of await ctx.store.list(accountId, CALENDAR_EVENT)) {
    // An event that was called off reminds nobody.
    if (record.value['status'] === 'cancelled') continue;
    for (const each of expand(record.value, from - FURTHEST, to + FURTHEST)) {
      const { event } = each;
      const whole = event['showWithoutTime'] === true;
      let alerts = event['alerts'];
      if (event['useDefaultAlerts'] === true) {
        const calendar = Object.keys(
          (record.value['calendarIds'] as Record<string, true>) ?? {},
        )
          .map((id) => calendars.get(id))
          .find(Boolean);
        alerts =
          calendar?.[
            whole ? 'defaultAlertsWithoutTime' : 'defaultAlertsWithTime'
          ];
      }
      for (const time of triggers(alerts, each.utcStart, each.utcEnd)) {
        if (time <= from || time > to) continue;
        const place = isObject(event['locations'])
          ? Object.values(event['locations']).find(isObject)
          : undefined;
        found.push({
          eventId:
            each.recurrenceId === record.value['start']
              ? record.id
              : `${record.id}_${each.recurrenceId.replace(/[-:]/g, '')}`,
          title: typeof event['title'] === 'string' ? event['title'] : '',
          utcStart: new Date(each.utcStart).toISOString(),
          utcEnd: new Date(each.utcEnd).toISOString(),
          showWithoutTime: whole,
          location: typeof place?.['name'] === 'string' ? place['name'] : null,
          at: new Date(time).toISOString(),
          time,
        });
      }
    }
  }
  return found.sort((a, b) => a.time - b.time);
}

/** A reminder that came due longer ago than this is not told of late: it would only confuse. */
const NOT_LATER_THAN = 15 * 60_000;
/** How far ahead the next reminder is looked for. With none that near, it is looked for again then. */
const LOOK_AHEAD = 30 * 86_400_000;

async function toldUntil(ctx: MethodContext, now: number) {
  const [state] = await ctx.store.get(ctx.auth.accountId, ALERT_STATE, [
    STATE_ID,
  ]);
  const until = Date.parse(String(state?.value['until'] ?? ''));
  return {
    state,
    until: Math.max(Number.isNaN(until) ? 0 : until, now - NOT_LATER_THAN),
  };
}

/**
 * When the account next has a reminder to be told of, or to be looked at
 * again for one. Null when it has no events at all.
 */
export async function nextCalendarAlert(
  ctx: MethodContext,
  now: Date,
): Promise<Date | null> {
  const { until } = await toldUntil(ctx, now.getTime());
  const [next] = await alertsBetween(ctx, until, now.getTime() + LOOK_AHEAD);
  if (next) return new Date(Math.max(next.time, now.getTime()));
  const any = await ctx.store.list(ctx.auth.accountId, CALENDAR_EVENT);
  return any.length > 0 ? new Date(now.getTime() + LOOK_AHEAD) : null;
}

/**
 * The reminders that have come due and were not told of yet, which from now
 * on are: asking again gives none of them. With when to ask next.
 */
export async function takeCalendarAlerts(
  ctx: MethodContext,
  now: Date,
): Promise<{ due: CalendarAlert[]; next: Date | null }> {
  const { state, until } = await toldUntil(ctx, now.getTime());
  const due = await alertsBetween(ctx, until, now.getTime());
  const value = { until: now.toISOString() };
  await commit(ctx, [
    state
      ? {
          kind: 'update',
          type: ALERT_STATE,
          id: STATE_ID,
          value,
          expectedVersion: state.version,
        }
      : { kind: 'create', type: ALERT_STATE, id: STATE_ID, value },
  ]);
  return {
    due: due.map(({ time: _time, ...alert }) => alert),
    next: await nextCalendarAlert(ctx, now),
  };
}
