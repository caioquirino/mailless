import {
  expand,
  occurrenceAt,
  occurrenceId,
  parseOccurrenceId,
  repeats,
} from './recurrence.js';

const utc = (iso: string) => Date.parse(iso);
const event = (more: Record<string, unknown> = {}) => ({
  '@type': 'Event',
  title: 'Stand-up',
  start: '2026-10-05T09:00:00',
  duration: 'PT30M',
  timeZone: 'Europe/Lisbon',
  ...more,
});
/** When an event is on between two days, as the dates and times of its wall. */
const times = (
  given: Record<string, unknown>,
  from = '2026-10-01',
  to = '2026-11-01',
) =>
  expand(given, utc(`${from}T00:00:00Z`), utc(`${to}T00:00:00Z`)).map(
    (each) => each.event['start'],
  );

describe('an event that repeats', () => {
  it('is on once when it has no rule', () => {
    expect(repeats(event())).toBe(false);
    expect(times(event())).toEqual(['2026-10-05T09:00:00']);
    expect(times(event(), '2026-10-06')).toEqual([]);
  });

  it('comes every day, every other week, until a day or so many times', () => {
    expect(
      times(event({ recurrenceRules: [{ frequency: 'daily', count: 3 }] })),
    ).toEqual([
      '2026-10-05T09:00:00',
      '2026-10-06T09:00:00',
      '2026-10-07T09:00:00',
    ]);
    expect(
      times(event({ recurrenceRules: [{ frequency: 'weekly', interval: 2 }] })),
    ).toEqual(['2026-10-05T09:00:00', '2026-10-19T09:00:00']);
    expect(
      times(
        event({
          recurrenceRules: [
            { frequency: 'weekly', until: '2026-10-12T09:00:00' },
          ],
        }),
      ),
    ).toEqual(['2026-10-05T09:00:00', '2026-10-12T09:00:00']);
    // The one rule of the JSCalendar that follows RFC 8984 is read as well.
    expect(
      times(event({ recurrenceRule: { frequency: 'weekly', count: 2 } })),
    ).toHaveLength(2);
  });

  it('comes on the days of the week it names', () => {
    const weekdays = ['mo', 'tu', 'we', 'th', 'fr'].map((day) => ({ day }));
    expect(
      times(
        event({ recurrenceRules: [{ frequency: 'weekly', byDay: weekdays }] }),
        '2026-10-08',
        '2026-10-14',
      ),
    ).toEqual([
      '2026-10-08T09:00:00',
      '2026-10-09T09:00:00',
      '2026-10-12T09:00:00',
      '2026-10-13T09:00:00',
    ]);
  });

  it('comes each month on its day, or on the second Tuesday, or on the last day', () => {
    const monthly = (rule: object, start = '2026-01-31T09:00:00') =>
      times(
        event({ start, recurrenceRules: [{ frequency: 'monthly', ...rule }] }),
        '2026-01-01',
        '2026-05-01',
      );
    // A month without a 31st has none.
    expect(monthly({})).toEqual(['2026-01-31T09:00:00', '2026-03-31T09:00:00']);
    expect(monthly({ byMonthDay: [-1] })).toEqual([
      '2026-01-31T09:00:00',
      '2026-02-28T09:00:00',
      '2026-03-31T09:00:00',
      '2026-04-30T09:00:00',
    ]);
    expect(
      monthly(
        { byDay: [{ day: 'tu', nthOfPeriod: 2 }] },
        '2026-01-13T09:00:00',
      ),
    ).toEqual([
      '2026-01-13T09:00:00',
      '2026-02-10T09:00:00',
      '2026-03-10T09:00:00',
      '2026-04-14T09:00:00',
    ]);
  });

  it('comes each year, a birthday on 29 February only in the years that have one', () => {
    expect(
      times(
        event({
          start: '2024-02-29T00:00:00',
          duration: 'P1D',
          timeZone: null,
          recurrenceRules: [{ frequency: 'yearly' }],
        }),
        '2024-01-01',
        '2029-01-01',
      ),
    ).toEqual(['2024-02-29T00:00:00', '2028-02-29T00:00:00']);
  });

  it('stays at its hour on the wall when the clocks change', () => {
    // Lisbon goes back an hour on 25 October 2026.
    const found = expand(
      event({ recurrenceRules: [{ frequency: 'weekly' }] }),
      utc('2026-10-19T00:00:00Z'),
      utc('2026-10-27T00:00:00Z'),
    );
    expect(found.map((each) => new Date(each.utcStart).toISOString())).toEqual([
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ]);
  });

  it('is found from far ahead without being counted through for ever', () => {
    expect(
      times(
        event({ recurrenceRules: [{ frequency: 'daily' }] }),
        '2031-03-01',
        '2031-03-03',
      ),
    ).toEqual(['2031-03-01T09:00:00', '2031-03-02T09:00:00']);
    // A rule that never comes to anything ends, too.
    expect(
      times(
        event({
          recurrenceRules: [
            { frequency: 'monthly', byMonthDay: [31], byMonth: [2] },
          ],
        }),
      ),
    ).toEqual(['2026-10-05T09:00:00']);
  });
});

describe('one occurrence of it', () => {
  const series = event({
    recurrenceRules: [{ frequency: 'weekly' }],
    recurrenceOverrides: {
      '2026-10-12T09:00:00': { excluded: true },
      '2026-10-19T09:00:00': {
        title: 'Stand-up, longer',
        start: '2026-10-19T10:00:00',
        'locations/1/name': 'Room 2',
        uid: 'not for one',
      },
      '2026-10-21T15:00:00': { title: 'An extra one' },
    },
  });

  it('can be left out, changed, or added', () => {
    const found = expand(
      series,
      utc('2026-10-05T00:00:00Z'),
      utc('2026-10-27T00:00:00Z'),
    );
    expect(
      found.map((each) => [
        each.recurrenceId,
        each.event['start'],
        each.event['title'],
      ]),
    ).toEqual([
      ['2026-10-05T09:00:00', '2026-10-05T09:00:00', 'Stand-up'],
      ['2026-10-19T09:00:00', '2026-10-19T10:00:00', 'Stand-up, longer'],
      ['2026-10-21T15:00:00', '2026-10-21T15:00:00', 'An extra one'],
      ['2026-10-26T09:00:00', '2026-10-26T09:00:00', 'Stand-up'],
    ]);
    const changed = found[1]?.event ?? {};
    expect(changed['locations']).toEqual({ '1': { name: 'Room 2' } });
    // It is one event, whatever one of its times says of itself.
    expect(changed['uid']).toBeUndefined();
    expect(changed['recurrenceRules']).toBeUndefined();
  });

  it('is found by when it is, and is not there when it was left out', () => {
    expect(occurrenceAt(series, '2026-10-26T09:00:00')?.event['title']).toBe(
      'Stand-up',
    );
    expect(occurrenceAt(series, '2026-10-19T09:00:00')?.event['start']).toBe(
      '2026-10-19T10:00:00',
    );
    expect(occurrenceAt(series, '2026-10-12T09:00:00')).toBeUndefined();
    expect(occurrenceAt(series, '2026-10-27T09:00:00')).toBeUndefined();
    expect(occurrenceAt(series, 'sometime')).toBeUndefined();
  });

  it('goes by an id made of the event’s and its time', () => {
    const id = occurrenceId('ev1a2b', '2026-10-26T09:00:00');
    expect(id).toBe('ev1a2b_20261026T090000');
    expect(parseOccurrenceId(id)).toEqual({
      eventId: 'ev1a2b',
      recurrenceId: '2026-10-26T09:00:00',
    });
    expect(parseOccurrenceId('ev1a2b')).toBeUndefined();
  });
});
