import { durationMillis, isTimeZone, zonedToUtc } from './time.js';

const HOUR = 3_600_000;

describe('durations', () => {
  it('are read as JSCalendar writes them', () => {
    expect(durationMillis('PT1H')).toBe(HOUR);
    expect(durationMillis('PT1H30M')).toBe(1.5 * HOUR);
    expect(durationMillis('P1D')).toBe(24 * HOUR);
    expect(durationMillis('P1W2DT3H4M5S')).toBe(
      (9 * 24 + 3) * HOUR + 4 * 60_000 + 5000,
    );
    expect(durationMillis('PT0S')).toBe(0);
  });

  it('are not whatever else is given', () => {
    for (const not of ['', 'P', 'PT', '1H', 'an hour', 'P1H', '-PT1H']) {
      expect(durationMillis(not)).toBeNull();
    }
  });
});

describe('a time on a wall', () => {
  it('is an instant once the wall is known', () => {
    const at = (local: string, zone: string | null) =>
      new Date(zonedToUtc(local, zone)).toISOString();
    expect(at('2026-10-09T13:00:00', 'Europe/Lisbon')).toBe(
      '2026-10-09T12:00:00.000Z',
    );
    expect(at('2026-12-09T13:00:00', 'Europe/Lisbon')).toBe(
      '2026-12-09T13:00:00.000Z',
    );
    expect(at('2026-07-01T09:00:00', 'America/New_York')).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    // A time that floats is the same on every wall: taken as UTC.
    expect(at('2026-10-09T13:00:00', null)).toBe('2026-10-09T13:00:00.000Z');
  });

  it('is right on either side of a change of clocks', () => {
    // Lisbon goes back an hour at 02:00 on 25 October 2026.
    expect(
      new Date(
        zonedToUtc('2026-10-25T00:30:00', 'Europe/Lisbon'),
      ).toISOString(),
    ).toBe('2026-10-24T23:30:00.000Z');
    expect(
      new Date(
        zonedToUtc('2026-10-25T03:00:00', 'Europe/Lisbon'),
      ).toISOString(),
    ).toBe('2026-10-25T03:00:00.000Z');
  });

  it('knows a zone from a word that is not one', () => {
    expect(isTimeZone('Europe/Lisbon')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});
