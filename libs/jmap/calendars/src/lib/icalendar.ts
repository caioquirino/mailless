import { durationMillis, isTimeZone, zonedToUtc } from './time.js';

/*
 * Events as other calendars exchange them: iCalendar (RFC 5545), which is
 * what an invitation sent by mail carries (RFC 6047) and what a file with
 * the ending .ics holds. An event is kept here as JSCalendar; this turns one
 * into the other, both ways, for what an invitation says: when, where, who,
 * how it repeats, and what each of those invited answered.
 */

/** What a message that carries an event is for (RFC 5546). */
export type Method = 'REQUEST' | 'REPLY' | 'CANCEL' | 'PUBLISH';

type Event = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ----------------------------------------------------------------- writing

/** Text as a property holds it: what would end it or part it is written with a backslash. */
const escape = (text: string) =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/([,;])/g, '\\$1');

/** A parameter's value: quoted when it holds what would end it. */
const param = (text: string) => {
  const clean = text.replace(/["\r\n]/g, ' ');
  return /[,;:]/.test(clean) ? `"${clean}"` : clean;
};

const encoder = new TextEncoder();

/** A line no longer than 75 octets: what is over goes on lines that begin with a space. */
function fold(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const letter of line) {
    const octets = encoder.encode(letter).length;
    if (size + octets > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += letter;
    size += octets;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const compact = (local: string) => local.replace(/[-:]/g, '');
const utcStamp = (moment: number) =>
  `${compact(new Date(moment).toISOString().slice(0, 19))}Z`;

const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

function ruleLine(rule: unknown, zone: string | null): string | null {
  if (!isObject(rule) || typeof rule['frequency'] !== 'string') return null;
  const parts = [`FREQ=${rule['frequency'].toUpperCase()}`];
  if (Number(rule['interval'] ?? 1) > 1) {
    parts.push(`INTERVAL=${Number(rule['interval'])}`);
  }
  if (rule['count'] !== undefined) parts.push(`COUNT=${Number(rule['count'])}`);
  if (typeof rule['until'] === 'string') {
    // Said in the world's time, as it has to be beside a start that names its zone.
    parts.push(`UNTIL=${utcStamp(zonedToUtc(rule['until'], zone))}`);
  }
  if (Array.isArray(rule['byDay']) && rule['byDay'].length > 0) {
    parts.push(
      `BYDAY=${rule['byDay']
        .filter(isObject)
        .map(
          (each) =>
            `${Number.isInteger(each['nthOfPeriod']) ? each['nthOfPeriod'] : ''}${String(each['day']).toUpperCase()}`,
        )
        .join(',')}`,
    );
  }
  for (const [property, name] of [
    ['byMonthDay', 'BYMONTHDAY'],
    ['byMonth', 'BYMONTH'],
  ] as const) {
    const value = rule[property];
    if (Array.isArray(value) && value.length > 0) {
      parts.push(`${name}=${value.map(String).join(',')}`);
    }
  }
  if (typeof rule['firstDayOfWeek'] === 'string') {
    parts.push(`WKST=${rule['firstDayOfWeek'].toUpperCase()}`);
  }
  return `RRULE:${parts.join(';')}`;
}

const STATUS_OUT: Record<string, string> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  delegated: 'DELEGATED',
  'needs-action': 'NEEDS-ACTION',
};

const address = (participant: Record<string, unknown>): string | null => {
  const imip = isObject(participant['sendTo'])
    ? participant['sendTo']['imip']
    : undefined;
  const found =
    typeof imip === 'string'
      ? imip.replace(/^mailto:/i, '')
      : typeof participant['email'] === 'string'
        ? participant['email']
        : null;
  return found ? found.trim().toLowerCase() : null;
};

/** The address of whoever an event is from, when it says. */
export function organizerOf(event: Event): string | null {
  const replyTo = event['replyTo'];
  if (isObject(replyTo) && typeof replyTo['imip'] === 'string') {
    return replyTo['imip']
      .replace(/^mailto:/i, '')
      .trim()
      .toLowerCase();
  }
  if (isObject(event['participants'])) {
    for (const each of Object.values(event['participants'])) {
      if (isObject(each) && isObject(each['roles']) && each['roles']['owner']) {
        return address(each);
      }
    }
  }
  return null;
}

/** Those invited to an event, by address: everyone on it but whoever it is from. */
export function attendeesOf(
  event: Event,
): Array<{ email: string; participant: Record<string, unknown> }> {
  const organizer = organizerOf(event);
  if (!isObject(event['participants'])) return [];
  return Object.values(event['participants']).flatMap((each) => {
    if (!isObject(each)) return [];
    const email = address(each);
    const roles = isObject(each['roles']) ? each['roles'] : {};
    // Whoever it is from is also invited when they are down as attending: but not written to.
    if (!email || (email === organizer && !roles['attendee'])) return [];
    return [{ email, participant: each }];
  });
}

function eventLines(
  event: Event,
  stamp: string,
  /** For a reply: only this one of those invited is said anything of. */
  only: string | null,
  recurrenceId?: string,
): string[] {
  const zone = (event['timeZone'] as string | null | undefined) ?? null;
  const start = String(event['start']);
  const whole = event['showWithoutTime'] === true;
  const length = durationMillis(String(event['duration'] ?? 'PT0S')) ?? 0;
  const repeating =
    recurrenceId === undefined &&
    (Array.isArray(event['recurrenceRules'])
      ? event['recurrenceRules'].length > 0
      : isObject(event['recurrenceRule']));
  const when = (property: string, local: string): string => {
    if (whole) return `${property};VALUE=DATE:${compact(local.slice(0, 10))}`;
    if (zone === null) return `${property}:${compact(local)}`;
    // An event that repeats keeps to its own clock; one that does not is said in the world's time, which every program reads.
    return repeating || recurrenceId !== undefined
      ? `${property};TZID=${zone}:${compact(local)}`
      : `${property}:${utcStamp(zonedToUtc(local, zone))}`;
  };
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escape(String(event['uid']))}`,
    `SEQUENCE:${Number(event['sequence'] ?? 0)}`,
    `DTSTAMP:${stamp}`,
    when('DTSTART', start),
  ];
  if (recurrenceId !== undefined)
    lines.push(when('RECURRENCE-ID', recurrenceId));
  const end = new Date(Date.parse(`${start}Z`) + length)
    .toISOString()
    .slice(0, 19);
  if (whole) {
    lines.push(when('DTEND', end));
  } else if (repeating || zone === null || recurrenceId !== undefined) {
    lines.push(`DURATION:${String(event['duration'] ?? 'PT0S')}`);
  } else {
    lines.push(`DTEND:${utcStamp(zonedToUtc(start, zone) + length)}`);
  }
  lines.push(`SUMMARY:${escape(String(event['title'] ?? ''))}`);
  const link = isObject(event['virtualLocations'])
    ? Object.values(event['virtualLocations'])
        .filter(isObject)
        .map((each) => each['uri'])
        .find((uri): uri is string => typeof uri === 'string')
    : undefined;
  const description = [event['description'], link]
    .filter((each): each is string => typeof each === 'string' && each !== '')
    .join('\n\n');
  if (description) lines.push(`DESCRIPTION:${escape(description)}`);
  if (link) lines.push(`CONFERENCE;VALUE=URI:${link}`);
  const place = isObject(event['locations'])
    ? Object.values(event['locations'])
        .filter(isObject)
        .map((each) => each['name'])
        .find((name): name is string => typeof name === 'string')
    : undefined;
  if (place) lines.push(`LOCATION:${escape(place)}`);
  lines.push(
    `STATUS:${event['status'] === 'cancelled' ? 'CANCELLED' : event['status'] === 'tentative' ? 'TENTATIVE' : 'CONFIRMED'}`,
  );
  const organizer = organizerOf(event);
  if (organizer) {
    const named = isObject(event['participants'])
      ? Object.values(event['participants'])
          .filter(isObject)
          .find((each) => address(each) === organizer)
      : undefined;
    lines.push(
      `ORGANIZER${typeof named?.['name'] === 'string' && named['name'] ? `;CN=${param(named['name'])}` : ''}:mailto:${organizer}`,
    );
  }
  for (const { email, participant } of attendeesOf(event)) {
    if (only !== null && email !== only) continue;
    const status =
      STATUS_OUT[String(participant['participationStatus'] ?? '')] ??
      'NEEDS-ACTION';
    const roles = isObject(participant['roles']) ? participant['roles'] : {};
    lines.push(
      [
        'ATTENDEE',
        typeof participant['name'] === 'string' && participant['name']
          ? `CN=${param(participant['name'])}`
          : null,
        `ROLE=${roles['optional'] ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'}`,
        `PARTSTAT=${status}`,
        only === null && status === 'NEEDS-ACTION' ? 'RSVP=TRUE' : null,
      ]
        .filter(Boolean)
        .join(';') + `:mailto:${email}`,
    );
  }
  if (repeating) {
    const rules = Array.isArray(event['recurrenceRules'])
      ? event['recurrenceRules']
      : [event['recurrenceRule']];
    for (const rule of rules) {
      const line = ruleLine(rule, zone);
      if (line) lines.push(line);
    }
    const overrides = isObject(event['recurrenceOverrides'])
      ? event['recurrenceOverrides']
      : {};
    for (const [id, patch] of Object.entries(overrides)) {
      if (isObject(patch) && patch['excluded'] === true) {
        lines.push(when('EXDATE', id));
      }
    }
  }
  lines.push('END:VEVENT');
  return lines;
}

export interface WriteOptions {
  method?: Method;
  /** For a reply: the one of those invited who answers. */
  attendee?: string;
  now?: Date;
}

/** An event as an iCalendar object: what an invitation carries, or a file holds. */
export function toICalendar(event: Event, options: WriteOptions = {}): string {
  const stamp = utcStamp((options.now ?? new Date()).getTime());
  const only = options.attendee?.trim().toLowerCase() ?? null;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mailless//calendar//EN',
    'CALSCALE:GREGORIAN',
    ...(options.method ? [`METHOD:${options.method}`] : []),
    ...eventLines(event, stamp, only),
  ];
  // What was changed for one of its times is an event of its own, that says which time it is.
  const overrides = isObject(event['recurrenceOverrides'])
    ? event['recurrenceOverrides']
    : {};
  for (const [id, patch] of Object.entries(overrides)) {
    if (!isObject(patch) || patch['excluded'] === true) continue;
    const once: Event = { ...event, start: id };
    for (const [property, value] of Object.entries(patch)) {
      if (!property.includes('/')) once[property] = value;
    }
    lines.push(...eventLines(once, stamp, only, id));
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ----------------------------------------------------------------- reading

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

function readLines(text: string): Line[] {
  // A line that begins with a space or a tab goes on from the one before.
  const whole = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  return whole.flatMap((line): Line[] => {
    // The name and its parameters end at the first colon that is not inside quotes.
    let quoted = false;
    let at = -1;
    for (let index = 0; index < line.length; index++) {
      if (line[index] === '"') quoted = !quoted;
      else if (line[index] === ':' && !quoted) {
        at = index;
        break;
      }
    }
    if (at < 0) return [];
    const [name, ...rest] = line
      .slice(0, at)
      .split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const params: Record<string, string> = {};
    for (const each of rest) {
      const equals = each.indexOf('=');
      if (equals > 0) {
        params[each.slice(0, equals).toUpperCase()] = each
          .slice(equals + 1)
          .replace(/^"|"$/g, '');
      }
    }
    return [
      { name: (name ?? '').toUpperCase(), params, value: line.slice(at + 1) },
    ];
  });
}

const unescape = (text: string) =>
  text.replace(/\\([\\,;nN])/g, (_, letter: string) =>
    letter === 'n' || letter === 'N' ? '\n' : letter,
  );

/** The zones Windows names in its own way, as the rest of the world names them. */
const WINDOWS_ZONES: Record<string, string> = {
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'SA Pacific Standard Time': 'America/Bogota',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  UTC: 'Etc/UTC',
};

/** A date or a date and time as written, on the wall of the zone it names. */
function readTime(line: Line): {
  local: string;
  zone: string | null;
  whole: boolean;
} | null {
  const found = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    line.value.trim(),
  );
  if (!found) return null;
  const [, year, month, day, hour, minute, second, utc] = found;
  if (hour === undefined) {
    return {
      local: `${year}-${month}-${day}T00:00:00`,
      zone: null,
      whole: true,
    };
  }
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (utc) return { local, zone: 'Etc/UTC', whole: false };
  const named = line.params['TZID'];
  const zone =
    named === undefined
      ? null
      : isTimeZone(named)
        ? named
        : (WINDOWS_ZONES[named] ?? null);
  return { local, zone, whole: false };
}

function millisAsDuration(millis: number, whole: boolean): string {
  const minutes = Math.max(0, Math.round(millis / 60_000));
  if (whole) return `P${Math.max(1, Math.round(minutes / 1440))}D`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const time = `${hours ? `${hours}H` : ''}${rest ? `${rest}M` : ''}`;
  return `P${days ? `${days}D` : ''}${time || !days ? `T${time || '0S'}` : ''}`;
}

function readRule(
  value: string,
  zone: string | null,
): Record<string, unknown> | null {
  const parts = Object.fromEntries(
    value.split(';').map((each) => {
      const [name, ...rest] = each.split('=');
      return [(name ?? '').toUpperCase(), rest.join('=')];
    }),
  );
  const frequency = parts['FREQ']?.toLowerCase();
  if (!frequency) return null;
  const rule: Record<string, unknown> = {
    '@type': 'RecurrenceRule',
    frequency,
  };
  if (parts['INTERVAL']) rule['interval'] = Number(parts['INTERVAL']);
  if (parts['COUNT']) rule['count'] = Number(parts['COUNT']);
  if (parts['UNTIL']) {
    const until = readTime({
      name: 'UNTIL',
      params: {},
      value: parts['UNTIL'],
    });
    if (until) {
      // Kept on the event's own wall, where the rest of its times are.
      rule['until'] =
        until.zone === 'Etc/UTC' && zone !== null && zone !== 'Etc/UTC'
          ? wallIn(zonedToUtc(until.local, 'Etc/UTC'), zone)
          : until.whole
            ? `${until.local.slice(0, 10)}T23:59:59`
            : until.local;
    }
  }
  if (parts['BYDAY']) {
    rule['byDay'] = parts['BYDAY'].split(',').flatMap((each) => {
      const found = /^([+-]?\d+)?([A-Z]{2})$/i.exec(each.trim());
      if (!found || !WEEKDAYS.includes((found[2] ?? '').toLowerCase()))
        return [];
      return [
        {
          day: (found[2] ?? '').toLowerCase(),
          ...(found[1] ? { nthOfPeriod: Number(found[1]) } : {}),
        },
      ];
    });
  }
  if (parts['BYMONTHDAY']) {
    rule['byMonthDay'] = parts['BYMONTHDAY'].split(',').map(Number);
  }
  if (parts['BYMONTH']) rule['byMonth'] = parts['BYMONTH'].split(',');
  if (parts['WKST']) rule['firstDayOfWeek'] = parts['WKST'].toLowerCase();
  return rule;
}

/** The date and time the clocks of a zone show at an instant. */
function wallIn(instant: number, zone: string): string {
  // Found by asking what instant that wall would be, and closing the gap.
  let guess = instant;
  for (let round = 0; round < 3; round++) {
    const shown = new Date(guess).toISOString().slice(0, 19);
    guess += instant - zonedToUtc(shown, zone);
  }
  return new Date(guess).toISOString().slice(0, 19);
}

const STATUS_IN: Record<string, string> = {
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
  DELEGATED: 'delegated',
  'NEEDS-ACTION': 'needs-action',
};

const mailOf = (value: string) =>
  value
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase();

function readEvent(lines: readonly Line[]): Event | null {
  const one = (name: string) => lines.find((line) => line.name === name);
  const uid = one('UID');
  const startLine = one('DTSTART');
  const start = startLine ? readTime(startLine) : null;
  if (!uid || !start) return null;
  const event: Event = {
    '@type': 'Event',
    uid: unescape(uid.value),
    title: unescape(one('SUMMARY')?.value ?? ''),
    start: start.local,
    timeZone: start.zone,
    showWithoutTime: start.whole,
    sequence: Number(one('SEQUENCE')?.value ?? 0) || 0,
  };
  const endLine = one('DTEND');
  const end = endLine ? readTime(endLine) : null;
  const duration = one('DURATION')?.value.trim();
  if (duration && durationMillis(duration) !== null) {
    event['duration'] = duration;
  } else if (end) {
    event['duration'] = millisAsDuration(
      zonedToUtc(end.local, end.zone) - zonedToUtc(start.local, start.zone),
      start.whole,
    );
  } else {
    event['duration'] = start.whole ? 'P1D' : 'PT0S';
  }
  const description = one('DESCRIPTION');
  if (description?.value) event['description'] = unescape(description.value);
  const place = one('LOCATION');
  if (place?.value) {
    event['locations'] = {
      '1': { '@type': 'Location', name: unescape(place.value) },
    };
  }
  const link = one('CONFERENCE') ?? one('URL');
  if (link && /^https?:\/\//i.test(link.value.trim())) {
    event['virtualLocations'] = {
      '1': { '@type': 'VirtualLocation', uri: link.value.trim() },
    };
  }
  const status = one('STATUS')?.value.trim().toUpperCase();
  if (status === 'CANCELLED') event['status'] = 'cancelled';
  else if (status === 'TENTATIVE') event['status'] = 'tentative';

  const participants: Record<string, Record<string, unknown>> = {};
  const add = (email: string, more: Record<string, unknown>) => {
    const key =
      Object.keys(participants).find(
        (each) => participants[each]?.['email'] === email,
      ) ?? String(Object.keys(participants).length + 1);
    const before = participants[key] ?? {
      '@type': 'Participant',
      email,
      sendTo: { imip: `mailto:${email}` },
      roles: {},
    };
    participants[key] = {
      ...before,
      ...more,
      roles: { ...(before['roles'] as object), ...(more['roles'] as object) },
    };
  };
  const organizer = one('ORGANIZER');
  if (organizer && organizer.value.includes('@')) {
    const email = mailOf(organizer.value);
    event['replyTo'] = { imip: `mailto:${email}` };
    add(email, {
      ...(organizer.params['CN'] ? { name: organizer.params['CN'] } : {}),
      roles: { owner: true },
    });
  }
  for (const line of lines) {
    if (line.name !== 'ATTENDEE' || !line.value.includes('@')) continue;
    add(mailOf(line.value), {
      ...(line.params['CN'] ? { name: line.params['CN'] } : {}),
      participationStatus:
        STATUS_IN[(line.params['PARTSTAT'] ?? '').toUpperCase()] ??
        'needs-action',
      ...(line.params['RSVP']?.toUpperCase() === 'TRUE'
        ? { expectReply: true }
        : {}),
      roles: {
        attendee: true,
        ...(line.params['ROLE']?.toUpperCase() === 'OPT-PARTICIPANT'
          ? { optional: true }
          : {}),
      },
    });
  }
  if (Object.keys(participants).length > 0)
    event['participants'] = participants;

  const rules = lines
    .filter((line) => line.name === 'RRULE')
    .map((line) => readRule(line.value, start.zone))
    .filter((rule): rule is Record<string, unknown> => rule !== null);
  if (rules.length > 0) event['recurrenceRules'] = rules;
  const overrides: Record<string, unknown> = {};
  for (const line of lines) {
    if (line.name !== 'EXDATE') continue;
    for (const each of line.value.split(',')) {
      const when = readTime({ ...line, value: each });
      if (when) {
        overrides[
          when.zone === 'Etc/UTC' && start.zone && start.zone !== 'Etc/UTC'
            ? wallIn(zonedToUtc(when.local, 'Etc/UTC'), start.zone)
            : when.whole
              ? `${when.local.slice(0, 10)}T${start.local.slice(11)}`
              : when.local
        ] = { excluded: true };
      }
    }
  }
  if (Object.keys(overrides).length > 0)
    event['recurrenceOverrides'] = overrides;
  const once = one('RECURRENCE-ID');
  const which = once ? readTime(once) : null;
  if (which) event['recurrenceId'] = which.local;
  return event;
}

export interface Read {
  /** What the object is for, when it says. */
  method: Method | null;
  /** Its events: one that repeats with what was changed for some of its times folded into it. */
  events: Event[];
}

/** The events of an iCalendar object. What is not an event (to-dos, time zones) is passed over. */
export function fromICalendar(text: string): Read {
  const lines = readLines(text);
  const method = lines
    .find((line) => line.name === 'METHOD')
    ?.value.trim()
    .toUpperCase();
  const events: Event[] = [];
  let open: Line[] | null = null;
  let depth = 0;
  for (const line of lines) {
    if (line.name === 'BEGIN' && line.value.trim().toUpperCase() === 'VEVENT') {
      open = [];
      depth = 0;
    } else if (
      line.name === 'END' &&
      line.value.trim().toUpperCase() === 'VEVENT'
    ) {
      const event = open ? readEvent(open) : null;
      if (event) events.push(event);
      open = null;
    } else if (open) {
      // An alarm inside an event has properties of its own, which are not the event's.
      if (line.name === 'BEGIN') depth += 1;
      else if (line.name === 'END') depth -= 1;
      else if (depth === 0) open.push(line);
    }
  }
  // One time of an event that repeats, said apart, is what is different about that time.
  const whole = events.filter((event) => event['recurrenceId'] === undefined);
  for (const once of events) {
    const id = once['recurrenceId'];
    if (typeof id !== 'string') continue;
    const of = whole.find((event) => event['uid'] === once['uid']);
    if (!of) {
      whole.push(once);
      continue;
    }
    const patch: Record<string, unknown> = {};
    for (const property of [
      'title',
      'start',
      'duration',
      'description',
      'locations',
      'status',
    ]) {
      if (JSON.stringify(once[property]) !== JSON.stringify(of[property])) {
        patch[property] = once[property] ?? null;
      }
    }
    of['recurrenceOverrides'] = {
      ...(of['recurrenceOverrides'] as object | undefined),
      [id]: patch,
    };
  }
  return {
    method:
      method === 'REQUEST' ||
      method === 'REPLY' ||
      method === 'CANCEL' ||
      method === 'PUBLISH'
        ? method
        : null,
    events: whole,
  };
}
