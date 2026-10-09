import {
  attendeesOf,
  fromICalendar,
  organizerOf,
  toICalendar,
} from './icalendar.js';

const NOW = new Date('2026-10-09T10:00:00Z');
const event = (more: Record<string, unknown> = {}) => ({
  '@type': 'Event',
  uid: 'e1@example.com',
  sequence: 2,
  title: 'Lunch; with Ann, at one',
  start: '2026-10-15T13:00:00',
  duration: 'PT1H',
  timeZone: 'Europe/Lisbon',
  description: 'Bring the contract.\nSecond line.',
  locations: { '1': { '@type': 'Location', name: 'Luigi’s' } },
  replyTo: { imip: 'mailto:caio@example.com' },
  participants: {
    me: {
      '@type': 'Participant',
      name: 'Caio',
      email: 'caio@example.com',
      roles: { owner: true },
    },
    ann: {
      '@type': 'Participant',
      name: 'Ann, the one',
      email: 'Ann@Example.com',
      sendTo: { imip: 'mailto:ann@example.com' },
      participationStatus: 'needs-action',
      roles: { attendee: true },
    },
    bob: {
      '@type': 'Participant',
      email: 'bob@example.com',
      participationStatus: 'accepted',
      roles: { attendee: true, optional: true },
    },
  },
  ...more,
});
const lines = (text: string) => text.replace(/\r\n /g, '').split('\r\n');

describe('an event written for other calendars', () => {
  it('says when in the world’s time, who it is from and who is asked', () => {
    const written = toICalendar(event(), { method: 'REQUEST', now: NOW });
    expect(lines(written)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//mailless//calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:e1@example.com',
      'SEQUENCE:2',
      'DTSTAMP:20261009T100000Z',
      // Lisbon is an hour ahead of UTC in October.
      'DTSTART:20261015T120000Z',
      'DTEND:20261015T130000Z',
      'SUMMARY:Lunch\\; with Ann\\, at one',
      'DESCRIPTION:Bring the contract.\\nSecond line.',
      'LOCATION:Luigi’s',
      'STATUS:CONFIRMED',
      'ORGANIZER;CN=Caio:mailto:caio@example.com',
      'ATTENDEE;CN="Ann, the one";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ann@example.com',
      'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:bob@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
    // No line is longer than a mail program has to accept.
    for (const line of written.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(organizerOf(event())).toBe('caio@example.com');
    expect(attendeesOf(event()).map((each) => each.email)).toEqual([
      'ann@example.com',
      'bob@example.com',
    ]);
  });

  it('keeps one that repeats on its own clock, with what was left out and what was changed', () => {
    const written = lines(
      toICalendar(
        event({
          start: '2026-10-05T09:00:00',
          duration: 'PT30M',
          recurrenceRules: [
            {
              frequency: 'weekly',
              interval: 2,
              byDay: [{ day: 'mo' }, { day: 'we' }],
              until: '2026-12-18T23:59:59',
            },
          ],
          recurrenceOverrides: {
            '2026-10-07T09:00:00': { excluded: true },
            '2026-10-19T09:00:00': { title: 'Longer', duration: 'PT1H' },
          },
        }),
        { now: NOW },
      ),
    );
    expect(written).toContain('DTSTART;TZID=Europe/Lisbon:20261005T090000');
    expect(written).toContain('DURATION:PT30M');
    expect(written).toContain(
      'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261218T235959Z;BYDAY=MO,WE',
    );
    expect(written).toContain('EXDATE;TZID=Europe/Lisbon:20261007T090000');
    expect(written).toContain(
      'RECURRENCE-ID;TZID=Europe/Lisbon:20261019T090000',
    );
    expect(written.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(written).toContain('SUMMARY:Longer');
  });

  it('writes a whole day as a day, and an answer as the one who answers', () => {
    const whole = lines(
      toICalendar(
        event({
          start: '2026-10-15T00:00:00',
          duration: 'P2D',
          timeZone: null,
          showWithoutTime: true,
        }),
        { now: NOW },
      ),
    );
    expect(whole).toContain('DTSTART;VALUE=DATE:20261015');
    expect(whole).toContain('DTEND;VALUE=DATE:20261017');

    const answer = lines(
      toICalendar(event(), {
        method: 'REPLY',
        attendee: 'BOB@example.com',
        now: NOW,
      }),
    );
    expect(answer.filter((line) => line.startsWith('ATTENDEE'))).toEqual([
      'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:bob@example.com',
    ]);
    expect(answer).toContain('METHOD:REPLY');
  });
});

describe('an event read from other calendars', () => {
  it('is the same event again, after being written', () => {
    const { method, events } = fromICalendar(
      toICalendar(event(), { method: 'REQUEST', now: NOW }),
    );
    expect(method).toBe('REQUEST');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: 'e1@example.com',
      sequence: 2,
      title: 'Lunch; with Ann, at one',
      start: '2026-10-15T12:00:00',
      timeZone: 'Etc/UTC',
      duration: 'PT1H',
      description: 'Bring the contract.\nSecond line.',
      locations: { '1': { name: 'Luigi’s' } },
      replyTo: { imip: 'mailto:caio@example.com' },
    });
    expect(Object.values(events[0]?.['participants'] as object)).toMatchObject([
      { email: 'caio@example.com', name: 'Caio', roles: { owner: true } },
      {
        email: 'ann@example.com',
        name: 'Ann, the one',
        participationStatus: 'needs-action',
        expectReply: true,
        roles: { attendee: true },
      },
      {
        email: 'bob@example.com',
        participationStatus: 'accepted',
        roles: { attendee: true, optional: true },
      },
    ]);
  });

  it('reads what other programs write: folded lines, their names for zones, alarms and all', () => {
    const { method, events } = fromICalendar(
      [
        'BEGIN:VCALENDAR',
        'METHOD:REQUEST',
        'BEGIN:VTIMEZONE',
        'TZID:W. Europe Standard Time',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:040000008200E00074C5B7101A82E008',
        'SUMMARY:Quarterly ',
        ' review',
        'DTSTART;TZID="W. Europe Standard Time":20261012T130000',
        'DTEND;TZID="W. Europe Standard Time":20261012T143000',
        'RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=4',
        'EXDATE;TZID="W. Europe Standard Time":20261109T130000',
        'ORGANIZER;CN="Lindqvist, Marta":MAILTO:Marta@Example.com',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Caio:mailto:caio@example.com',
        'BEGIN:VALARM',
        'DESCRIPTION:Not the event’s',
        'TRIGGER:-PT15M',
        'END:VALARM',
        'URL:https://meet.example.com/x',
        'END:VEVENT',
        'BEGIN:VTODO',
        'UID:not-an-event',
        'END:VTODO',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    expect(method).toBe('REQUEST');
    expect(events).toEqual([
      {
        '@type': 'Event',
        uid: '040000008200E00074C5B7101A82E008',
        title: 'Quarterly review',
        start: '2026-10-12T13:00:00',
        timeZone: 'Europe/Berlin',
        showWithoutTime: false,
        sequence: 0,
        duration: 'PT1H30M',
        virtualLocations: {
          '1': {
            '@type': 'VirtualLocation',
            uri: 'https://meet.example.com/x',
          },
        },
        replyTo: { imip: 'mailto:marta@example.com' },
        participants: {
          '1': {
            '@type': 'Participant',
            email: 'marta@example.com',
            sendTo: { imip: 'mailto:marta@example.com' },
            name: 'Lindqvist, Marta',
            roles: { owner: true },
          },
          '2': {
            '@type': 'Participant',
            email: 'caio@example.com',
            sendTo: { imip: 'mailto:caio@example.com' },
            name: 'Caio',
            participationStatus: 'needs-action',
            expectReply: true,
            roles: { attendee: true },
          },
        },
        recurrenceRules: [
          {
            '@type': 'RecurrenceRule',
            frequency: 'monthly',
            count: 4,
            byDay: [{ day: 'mo', nthOfPeriod: 2 }],
          },
        ],
        recurrenceOverrides: { '2026-11-09T13:00:00': { excluded: true } },
      },
    ]);
  });

  it('folds one changed time of an event that repeats into the event', () => {
    const { events } = fromICalendar(
      toICalendar(
        event({
          start: '2026-10-05T09:00:00',
          recurrenceRules: [{ frequency: 'weekly' }],
          recurrenceOverrides: {
            '2026-10-12T09:00:00': {
              title: 'Moved',
              start: '2026-10-12T11:00:00',
            },
          },
        }),
        { now: NOW },
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.['recurrenceOverrides']).toEqual({
      '2026-10-12T09:00:00': { title: 'Moved', start: '2026-10-12T11:00:00' },
    });
  });

  it('reads a whole day, an answer, and nothing from what is not a calendar', () => {
    const { events } = fromICalendar(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d1\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261017\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR',
    );
    expect(events[0]).toMatchObject({
      start: '2026-10-15T00:00:00',
      timeZone: null,
      showWithoutTime: true,
      duration: 'P2D',
      status: 'cancelled',
    });
    expect(fromICalendar('Hello,\n\nSee you Thursday.')).toEqual({
      method: null,
      events: [],
    });
    expect(
      fromICalendar('BEGIN:VEVENT\nSUMMARY:No id, no time\nEND:VEVENT').events,
    ).toEqual([]);
  });
});
