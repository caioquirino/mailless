import type { MethodContext } from '@mailless/jmap-engine';
import {
  attendeesOf,
  organizerOf,
  toICalendar,
  type Method,
} from './icalendar.js';
import { durationMillis, zonedToUtc } from './time.js';

/*
 * Telling the others (RFC 5546, by mail: RFC 6047). An event with people on
 * it is theirs as well: whoever it is from tells those invited when it is
 * made, changed or called off, and each of those invited tells whoever it is
 * from what they answer. A calendar does not send mail; the host says how.
 */

/** Someone a message is from: an address the account's owner goes by. */
export interface Own {
  email: string;
  name?: string | null;
}

/** A message that carries an event, for the host to send by mail. */
export interface SchedulingMessage {
  from: Own;
  to: string[];
  subject: string;
  /** What it says, for whoever reads it in a program that shows no calendar. */
  text: string;
  method: Method;
  /** The event, as an iCalendar object. */
  calendar: string;
}

/** What a host gives a calendar so that it can tell the others. */
export interface Scheduling {
  /** The addresses the account's owner goes by. The first is the one they write from. */
  addresses(ctx: MethodContext): Promise<Own[]>;
  send(ctx: MethodContext, message: SchedulingMessage): Promise<void>;
}

type Event = Record<string, unknown>;

/** When an event is, in words, on its own clock. */
export function whenText(event: Event): string {
  const zone = (event['timeZone'] as string | null | undefined) ?? null;
  const start = zonedToUtc(String(event['start']), zone);
  const end =
    start + (durationMillis(String(event['duration'] ?? 'PT0S')) ?? 0);
  const whole = event['showWithoutTime'] === true;
  const timeZone = zone ?? 'UTC';
  const day = (moment: number) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone,
    }).format(new Date(moment));
  const time = (moment: number) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(new Date(moment));
  if (whole) {
    const last = end - 86_400_000;
    return last > start ? `${day(start)} to ${day(last)}` : day(start);
  }
  const until =
    day(end) === day(start) ? time(end) : `${day(end)}, ${time(end)}`;
  return `${day(start)}, ${time(start)} to ${until}${zone ? ` (${zone})` : ''}`;
}

function describe(event: Event, first: string): string {
  const place = Object.values(
    (event['locations'] as Record<string, { name?: string }> | undefined) ?? {},
  ).find((each) => typeof each?.name === 'string')?.name;
  const link = Object.values(
    (event['virtualLocations'] as
      Record<string, { uri?: string }> | undefined) ?? {},
  ).find((each) => typeof each?.uri === 'string')?.uri;
  return [
    first,
    '',
    String(event['title'] ?? '') || '(no title)',
    `When: ${whenText(event)}`,
    ...(place ? [`Where: ${place}`] : []),
    ...(link ? [`Join: ${link}`] : []),
    ...(typeof event['description'] === 'string' && event['description']
      ? ['', event['description']]
      : []),
    '',
  ].join('\n');
}

const title = (event: Event) => String(event['title'] ?? '') || '(no title)';

/** What someone who was invited says of an event, of their own addresses. */
function ownAnswer(
  event: Event | undefined,
  mine: ReadonlyMap<string, Own>,
): { own: Own; status: string } | undefined {
  if (!event) return undefined;
  for (const { email, participant } of attendeesOf(event)) {
    const own = mine.get(email);
    if (own) {
      return {
        own,
        status: String(participant['participationStatus'] ?? 'needs-action'),
      };
    }
  }
  return undefined;
}

const ANSWERS: Record<string, string> = {
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Maybe',
};

/**
 * The messages a change to an event calls for: `before` is the event as it
 * was, `after` as it is now; one of them is missing for an event that was
 * made or removed. None when the event has nobody else on it.
 */
export function messagesFor(
  before: Event | undefined,
  after: Event | undefined,
  addresses: readonly Own[],
  now: Date = new Date(),
): SchedulingMessage[] {
  const event = after ?? before;
  if (!event) return [];
  const mine = new Map(
    addresses.map((own) => [own.email.trim().toLowerCase(), own]),
  );
  const organizer = organizerOf(event);
  if (organizer === null) return [];
  const others = (of: Event | undefined) =>
    of
      ? attendeesOf(of)
          .map((each) => each.email)
          .filter((email) => !mine.has(email))
      : [];

  const from = mine.get(organizer);
  if (from) {
    // It is theirs to tell of.
    const messages: SchedulingMessage[] = [];
    const invited = others(after);
    const dropped = others(before).filter((email) => !invited.includes(email));
    if (after && invited.length > 0) {
      const known = others(before).length > 0;
      messages.push({
        from,
        to: invited,
        subject: `${known ? 'Updated invitation' : 'Invitation'}: ${title(after)}`,
        text: describe(
          after,
          known
            ? `${from.name || from.email} changed this event.`
            : `${from.name || from.email} invites you.`,
        ),
        method: 'REQUEST',
        calendar: toICalendar(after, { method: 'REQUEST', now }),
      });
    }
    if (before && dropped.length > 0) {
      const called = {
        ...before,
        status: 'cancelled',
        sequence: Number((after ?? before)['sequence'] ?? 0) + (after ? 0 : 1),
      };
      messages.push({
        from,
        to: dropped,
        subject: `Cancelled: ${title(before)}`,
        text: describe(
          before,
          after
            ? `${from.name || from.email} took you off this event.`
            : `${from.name || from.email} cancelled this event.`,
        ),
        method: 'CANCEL',
        calendar: toICalendar(called, { method: 'CANCEL', now }),
      });
    }
    return messages;
  }

  // Someone else's: what there is to tell is what was answered.
  const was = ownAnswer(before, mine);
  const is = ownAnswer(after, mine);
  // Removed from the calendar without a word is a no.
  const answer = after ? is : was ? { ...was, status: 'declined' } : undefined;
  if (!answer || !ANSWERS[answer.status]) return [];
  if (after && was && was.status === answer.status) return [];
  const answered: Event = after ?? {
    ...before,
    participants: Object.fromEntries(
      Object.entries(
        (before?.['participants'] as Record<string, Event> | undefined) ?? {},
      ).map(([key, each]) => [
        key,
        mine.has(String(each['email'] ?? '').toLowerCase())
          ? { ...each, participationStatus: 'declined' }
          : each,
      ]),
    ),
  };
  return [
    {
      from: answer.own,
      to: [organizer],
      subject: `${ANSWERS[answer.status]}: ${title(answered)}`,
      text: describe(
        answered,
        `${answer.own.name || answer.own.email} answered: ${ANSWERS[answer.status]?.toLowerCase()}.`,
      ),
      method: 'REPLY',
      calendar: toICalendar(answered, {
        method: 'REPLY',
        attendee: answer.own.email,
        now,
      }),
    },
  ];
}
