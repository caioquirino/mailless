import {
  dayKey,
  dayOf,
  eventOf,
  formOf,
  formProblem,
  formSpan,
  newForm,
  placeDay,
  reminderText,
  remindersOf,
  shown,
  weekStart,
  weekTitle,
  type CalendarEvent,
  type Shown,
} from './calendar';

const at = (day: string, time: string) => new Date(`${day}T${time}:00`);
const span = (id: string, from: string, to: string): Shown => ({
  event: { id } as CalendarEvent,
  start: at('2026-10-09', from),
  end: at('2026-10-09', to),
  allDay: false,
});

describe('days and weeks', () => {
  it('names a day, and finds the day a name is for', () => {
    expect(dayKey(new Date(2026, 9, 9, 15))).toBe('2026-10-09');
    expect(dayOf('2026-10-09').getHours()).toBe(0);
    // What names no day is today.
    expect(dayKey(dayOf('soon'))).toBe(dayKey(new Date()));
  });

  it('starts a week on its Monday, and says which days it has', () => {
    expect(dayKey(weekStart(dayOf('2026-10-09')))).toBe('2026-10-05');
    expect(dayKey(weekStart(dayOf('2026-10-11')))).toBe('2026-10-05');
    expect(weekTitle(dayOf('2026-10-05'), 'en-GB')).toBe('5 – 11 October 2026');
    expect(weekTitle(dayOf('2026-09-28'), 'en-GB')).toBe(
      '28 September – 4 October 2026',
    );
  });
});

describe('events that overlap', () => {
  it('stand side by side, in as few columns as will do', () => {
    const placed = placeDay([
      span('a', '09:00', '10:00'),
      span('b', '09:30', '10:30'),
      span('c', '10:00', '11:00'),
      span('d', '13:00', '14:00'),
    ]);
    const where = Object.fromEntries(
      placed.map((each) => [each.event.id, [each.column, each.columns]]),
    );
    // c begins as a ends, and takes its place beside b.
    expect(where).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });
});

describe('the form an event is written in', () => {
  const form = () => ({
    ...newForm('cal', at('2026-10-09', '13:00')),
    title: ' Lunch ',
  });

  it('starts an hour long, in the calendar given', () => {
    expect(form()).toMatchObject({
      id: null,
      date: '2026-10-09',
      endDate: '2026-10-09',
      from: '13:00',
      to: '14:00',
      allDay: false,
      calendarId: 'cal',
      reminders: null,
    });
  });

  it('becomes an event as the server keeps them', () => {
    expect(
      eventOf(
        {
          ...form(),
          place: 'Luigi’s',
          people: 'ann@example.com, bob@example.com',
          link: 'https://meet.example.com/x',
          reminders: [30, 1440],
        },
        'Europe/Lisbon',
      ),
    ).toMatchObject({
      calendarIds: { cal: true },
      title: 'Lunch',
      start: '2026-10-09T13:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Lisbon',
      showWithoutTime: false,
      locations: { '1': { name: 'Luigi’s' } },
      virtualLocations: { '1': { uri: 'https://meet.example.com/x' } },
      participants: {
        '1': { email: 'ann@example.com' },
        '2': { email: 'bob@example.com' },
      },
      useDefaultAlerts: false,
      alerts: {
        '1': { trigger: { offset: '-PT30M' } },
        '2': { trigger: { offset: '-P1D' } },
      },
    });
    // What is left empty is said to be so, which takes it off an event that had it.
    expect(eventOf(form(), 'Europe/Lisbon')).toMatchObject({
      description: null,
      locations: null,
      participants: null,
      alerts: null,
      useDefaultAlerts: true,
    });
  });

  it('keeps whole days as days, wherever they are looked at from', () => {
    const whole = eventOf(
      { ...form(), allDay: true, endDate: '2026-10-11' },
      'Europe/Lisbon',
    );
    expect(whole).toMatchObject({
      start: '2026-10-09T00:00:00',
      duration: 'P3D',
      timeZone: null,
      showWithoutTime: true,
    });
    const back = formOf({
      id: 'e1',
      ...(whole as object),
      utcStart: '2026-10-09T00:00:00Z',
      utcEnd: '2026-10-12T00:00:00Z',
    } as CalendarEvent);
    expect(back).toMatchObject({
      id: 'e1',
      allDay: true,
      date: '2026-10-09',
      endDate: '2026-10-11',
    });
  });

  it('takes an end before the start as the day after', () => {
    const late = formSpan({ ...form(), from: '23:00', to: '01:00' });
    expect(dayKey(late.end)).toBe('2026-10-10');
    expect(
      eventOf({ ...form(), from: '23:00', to: '01:00' }, 'UTC'),
    ).toMatchObject({ duration: 'PT2H' });
    expect(
      eventOf({ ...form(), from: '09:00', to: '09:45' }, 'UTC'),
    ).toMatchObject({ duration: 'PT45M' });
  });

  it('says what stops it from being kept', () => {
    expect(formProblem(form())).toBeNull();
    expect(formProblem({ ...form(), people: 'ann' })).toBe(
      '“ann” is not an address.',
    );
    expect(formProblem({ ...form(), link: 'meet.example.com' })).toMatch(
      /https/,
    );
    expect(formProblem({ ...form(), date: '' })).toBe('Choose a day.');
  });

  it('reads an event back, by the clock of whoever looks', () => {
    const event: CalendarEvent = {
      id: 'e1',
      calendarIds: { cal: true },
      title: 'Call',
      start: '2026-10-09T11:00:00',
      duration: 'PT30M',
      timeZone: 'UTC',
      useDefaultAlerts: false,
      alerts: { a: { trigger: { offset: '-PT15M' } } },
      utcStart: '2026-10-09T11:00:00Z',
      utcEnd: '2026-10-09T11:30:00Z',
    };
    const { start, end, allDay } = shown(event);
    expect(end.getTime() - start.getTime()).toBe(30 * 60_000);
    expect(allDay).toBe(false);
    expect(formOf(event)).toMatchObject({ title: 'Call', reminders: [15] });
  });
});

describe('an event that repeats, in the form', () => {
  const form = () => ({
    ...newForm('cal', at('2026-10-05', '09:00')),
    title: 'Stand-up',
  });

  it('says how in a rule the server keeps', () => {
    expect(eventOf(form(), 'UTC')).toMatchObject({ recurrenceRules: null });
    expect(
      eventOf({ ...form(), repeat: 'weekdays', until: '2026-12-18' }, 'UTC'),
    ).toMatchObject({
      recurrenceRules: [
        {
          frequency: 'weekly',
          byDay: ['mo', 'tu', 'we', 'th', 'fr'].map((day) => ({ day })),
          until: '2026-12-18T23:59:59',
        },
      ],
    });
    expect(eventOf({ ...form(), repeat: 'biweekly' }, 'UTC')).toMatchObject({
      recurrenceRules: [{ frequency: 'weekly', interval: 2 }],
    });
    // A way of repeating the form does not offer is not touched by it.
    expect(eventOf({ ...form(), repeat: 'custom' }, 'UTC')).not.toHaveProperty(
      'recurrenceRules',
    );
  });

  it('reads the rule back, and knows one of its times from the event', () => {
    const whole: CalendarEvent = {
      id: 'e1',
      calendarIds: { cal: true },
      title: 'Stand-up',
      start: '2026-10-05T09:00:00',
      duration: 'PT30M',
      timeZone: 'UTC',
      recurrenceRules: [
        { frequency: 'weekly', interval: 2, until: '2026-12-18T23:59:59' },
      ],
      utcStart: '2026-10-05T09:00:00Z',
      utcEnd: '2026-10-05T09:30:00Z',
    };
    expect(formOf(whole)).toMatchObject({
      repeat: 'biweekly',
      until: '2026-12-18',
      series: null,
    });
    const { recurrenceRules: _rules, ...rest } = whole;
    const once: CalendarEvent = {
      ...rest,
      id: 'e1_20261019T090000',
      baseEventId: 'e1',
      recurrenceId: '2026-10-19T09:00:00',
      start: '2026-10-19T09:00:00',
      utcStart: '2026-10-19T09:00:00Z',
      utcEnd: '2026-10-19T09:30:00Z',
    };
    expect(formOf(once, whole)).toMatchObject({
      id: 'e1_20261019T090000',
      date: '2026-10-19',
      repeat: 'biweekly',
      series: { id: 'e1', recurrenceId: '2026-10-19T09:00:00', all: false },
    });
    expect(
      formOf({
        ...whole,
        recurrenceRules: [
          { frequency: 'monthly', byDay: [{ day: 'tu', nthOfPeriod: 2 }] },
        ],
      }).repeat,
    ).toBe('custom');
  });
});

describe('an event with other people on it', () => {
  const own = [
    { email: 'Caio@example.com', name: 'Caio' },
    { email: 'c@work.example' },
  ];
  const form = () => ({
    ...newForm('cal', at('2026-10-15', '13:00')),
    title: 'Lunch',
    people: 'Ann@example.net, bob@example.net',
  });

  it('is from the person who writes it, who is on it too', () => {
    const event = eventOf(
      { ...form(), answers: { 'ann@example.net': 'accepted' } },
      'UTC',
      own,
    );
    expect(event).toMatchObject({
      replyTo: { imip: 'mailto:caio@example.com' },
      participants: {
        me: {
          name: 'Caio',
          email: 'caio@example.com',
          participationStatus: 'accepted',
          roles: { owner: true, attendee: true },
        },
        // What someone answered is kept when the event is written again.
        '1': { email: 'ann@example.net', participationStatus: 'accepted' },
        '2': {
          email: 'bob@example.net',
          participationStatus: 'needs-action',
          expectReply: true,
        },
      },
    });
    expect(
      eventOf({ ...form(), as: 'c@work.example' }, 'UTC', own),
    ).toMatchObject({ replyTo: { imip: 'mailto:c@work.example' } });
    // With nobody else on it, it is from nobody and nobody is on it.
    expect(eventOf({ ...form(), people: '' }, 'UTC', own)).toMatchObject({
      participants: null,
      replyTo: null,
    });
  });

  it('is read back as theirs to change, or as an invitation to answer', () => {
    const base = {
      id: 'e1',
      calendarIds: { cal: true as const },
      start: '2026-10-15T13:00:00',
      duration: 'PT1H',
      timeZone: 'UTC',
      utcStart: '2026-10-15T13:00:00Z',
      utcEnd: '2026-10-15T14:00:00Z',
    };
    const mine = formOf(
      {
        ...base,
        ...(eventOf(form(), 'UTC', own) as object),
      } as CalendarEvent,
      undefined,
      own,
    );
    expect(mine).toMatchObject({
      people: 'ann@example.net, bob@example.net',
      as: 'caio@example.com',
      invited: null,
    });

    const theirs = formOf(
      {
        ...base,
        replyTo: { imip: 'mailto:marta@example.org' },
        participants: {
          m: { email: 'marta@example.org', roles: { owner: true } },
          c: { email: 'caio@example.com', participationStatus: 'tentative' },
          j: { email: 'jonas@example.org', participationStatus: 'accepted' },
        },
      },
      undefined,
      own,
    );
    expect(theirs.invited).toEqual({
      by: 'marta@example.org',
      answer: 'tentative',
    });
    // Who else is on it is not the person's to say: nothing is said of it.
    expect(eventOf(theirs, 'UTC', own)).not.toHaveProperty('participants');
    expect(eventOf(theirs, 'UTC', own)).not.toHaveProperty('replyTo');
  });
});

describe('reminders', () => {
  it('are said in words', () => {
    expect(reminderText(0)).toBe('When it starts');
    expect(reminderText(30)).toBe('30 minutes before');
    expect(reminderText(60)).toBe('1 hour before');
    expect(reminderText(2880)).toBe('2 days before');
    expect(reminderText(10080)).toBe('1 week before');
  });

  it('are read from what the server keeps', () => {
    expect(
      remindersOf({
        a: { trigger: { offset: '-P1D' } },
        b: { trigger: { offset: '-PT1H30M' } },
        c: { trigger: { offset: 'PT0S' } },
        d: { trigger: {} },
      }),
    ).toEqual([0, 90, 1440]);
  });
});
