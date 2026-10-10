import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dayKey, draftKey, newForm, weekStart } from '../lib/calendar';
import { fakeBackend, renderApp } from '../test-support';

const AUTH = { accountId: 'ann', username: 'ann@example.com' };
const today = dayKey(new Date());
const calendar = () => screen.getByRole('region', { name: 'Calendar' });
/** The button beside the calendar. There is another on the calendar itself, for a phone. */
const newEvent = () =>
  screen.getAllByRole('button', { name: 'New event' })[0] as HTMLElement;
/** The calendar, once it has been fetched and drawn. */
const opened = () => screen.findByRole('region', { name: 'Calendar' });

type Backend = Awaited<ReturnType<typeof fakeBackend>>;

/** What the server keeps, asked of it directly. */
async function call(backend: Backend, method: string, args: object = {}) {
  const response = (await backend.server.handleRequest(
    {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'],
      methodCalls: [[method, { accountId: AUTH.accountId, ...args }, 'c']],
    },
    AUTH,
  )) as unknown as { methodResponses: [string, Record<string, never>][] };
  return response.methodResponses[0]?.[1] as Record<string, never>;
}

const events = async (backend: Backend) =>
  (await call(backend, 'CalendarEvent/get', { ids: null }))['list'] as Array<{
    id: string;
    title: string;
    start: string;
    duration: string;
    recurrenceRules?: unknown[];
    locations?: Record<string, { name: string }>;
  }>;

async function addEvent(backend: Backend, more: object = {}) {
  const [{ id }] = (await call(backend, 'Calendar/get', { ids: null }))[
    'list'
  ] as Array<{ id: string }>;
  await call(backend, 'CalendarEvent/set', {
    create: {
      e: {
        calendarIds: { [id as string]: true },
        title: 'Dentist',
        start: `${today}T14:00:00`,
        duration: 'PT1H',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...more,
      },
    },
  });
}

describe('the calendar', () => {
  it('is reached from beside the mail, and opens on this week', async () => {
    const backend = await fakeBackend();
    await addEvent(backend);
    await renderApp(backend);
    await userEvent.click(
      within(
        await screen.findByRole('navigation', { name: 'Sections' }),
      ).getByRole('link', { name: 'Calendar' }),
    );
    const week = await within(await opened()).findByRole('grid', {
      name: 'Week',
    });
    expect(
      await within(week).findByRole('button', { name: /Dentist/ }),
    ).toHaveTextContent('14:00 – 15:00');
    // Its own menu: a month to find a day in, and the calendars.
    const menu = screen.getByRole('navigation', { name: 'Calendars' });
    expect(within(menu).getByLabelText('Personal')).toBeChecked();
    expect(
      within(menu).getByRole('link', { current: 'date' }),
    ).toHaveTextContent(String(new Date().getDate()));
  });

  it('changes this time of an event and every one after it, as an event of its own', async () => {
    const backend = await fakeBackend();
    const monday = dayKey(weekStart(new Date()));
    await addEvent(backend, {
      title: 'Stand-up',
      start: `${monday}T09:00:00`,
      duration: 'PT15M',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }],
    });
    await renderApp(backend, `/calendar/week/${monday}`);
    const week = await within(await opened()).findByRole('grid', {
      name: 'Week',
    });
    await waitFor(() =>
      expect(
        within(week).getAllByRole('button', { name: /^Stand-up09/ }),
      ).toHaveLength(7),
    );
    // Thursday, the fourth of the week.
    await userEvent.click(
      within(week).getAllByRole('button', {
        name: /^Stand-up09/,
      })[3] as HTMLElement,
    );
    const form = await screen.findByRole('form', { name: 'Event' });
    await userEvent.click(within(form).getByLabelText('This and following'));
    // From here on it may repeat another way.
    expect(within(form).getByLabelText('Repeats')).toHaveValue('daily');
    // The end goes with the start: it stays a quarter of an hour.
    fireEvent.change(within(form).getByLabelText('Starts'), {
      target: { value: '10:00' },
    });
    expect(within(form).getByLabelText('Ends')).toHaveValue('10:15');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        within(week).getAllByRole('button', { name: /^Stand-up10/ }),
      ).toHaveLength(4),
    );
    expect(
      within(week).getAllByRole('button', { name: /^Stand-up09/ }),
    ).toHaveLength(3);
    const kept = await events(backend);
    expect(kept).toHaveLength(2);
    expect(kept.map((each) => each.start.slice(11)).sort()).toEqual([
      '09:00:00',
      '10:00:00',
    ]);
  });

  it('takes in a calendar file, once, and gives a calendar out as one', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    const settings = await screen.findByRole('region', { name: 'Settings' });
    await within(settings).findByRole('list', { name: 'Your calendars' });
    const file = () =>
      new File(
        [
          [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:one@elsewhere.example',
            'DTSTART:20261015T120000Z',
            'DTEND:20261015T130000Z',
            'SUMMARY:Lunch',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:two@elsewhere.example',
            'DTSTART;VALUE=DATE:20261224',
            'DTEND;VALUE=DATE:20261225',
            'SUMMARY:Christmas Eve',
            'RRULE:FREQ=YEARLY',
            'END:VEVENT',
            'END:VCALENDAR',
          ].join('\r\n'),
        ],
        'elsewhere.ics',
        { type: 'text/calendar' },
      );
    await userEvent.click(
      within(settings).getByRole('button', {
        name: 'Import a file into Personal',
      }),
    );
    await userEvent.upload(
      within(settings).getByLabelText('Calendar file to import'),
      file(),
    );
    expect(
      await screen.findByText('2 events added to Personal'),
    ).toBeInTheDocument();
    const kept = await events(backend);
    expect(kept.map((each) => each.title).sort()).toEqual([
      'Christmas Eve',
      'Lunch',
    ]);
    expect(
      kept.find((each) => each.title === 'Christmas Eve')?.recurrenceRules,
    ).toHaveLength(1);

    // The same file again adds nothing.
    await userEvent.click(
      within(settings).getByRole('button', {
        name: 'Import a file into Personal',
      }),
    );
    await userEvent.upload(
      within(settings).getByLabelText('Calendar file to import'),
      file(),
    );
    expect(
      await screen.findByText('0 events added to Personal, 2 already there'),
    ).toBeInTheDocument();
    expect(await events(backend)).toHaveLength(2);
  });

  it('shows a calendar kept somewhere else, which is not changed here', async () => {
    const backend = await fakeBackend();
    const address = 'https://calendar.example/secret/basic.ics';
    const stamp = today.replace(/-/g, '');
    backend.feeds[address] = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:swim@elsewhere.example',
      `DTSTART:${stamp}T120000Z`,
      `DTEND:${stamp}T130000Z`,
      'SUMMARY:Swimming',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    await renderApp(backend, '/settings');
    const settings = await screen.findByRole('region', { name: 'Settings' });
    await userEvent.click(
      await within(settings).findByRole('button', {
        name: 'Subscribe to a calendar',
      }),
    );
    const form = within(settings).getByRole('form', {
      name: 'Subscribe to a calendar',
    });
    await userEvent.type(
      within(form).getByLabelText('Name of the calendar'),
      'Gmail',
    );
    // Nothing is published there: it is said, and no empty calendar is kept.
    await userEvent.type(
      within(form).getByLabelText('Address of the calendar'),
      'https://calendar.example/wrong.ics',
    );
    await userEvent.click(
      within(form).getByRole('button', { name: 'Subscribe' }),
    );
    expect(
      await screen.findByText(/Nothing is published there/),
    ).toBeInTheDocument();
    const all = within(settings).getByRole('list', { name: 'Your calendars' });
    expect(within(all).queryByText('Gmail')).not.toBeInTheDocument();

    const where = within(form).getByLabelText('Address of the calendar');
    await userEvent.clear(where);
    await userEvent.type(where, address);
    await userEvent.click(
      within(form).getByRole('button', { name: 'Subscribe' }),
    );
    expect(await within(all).findByText('Gmail')).toBeInTheDocument();
    expect(
      within(all).getByText(/kept somewhere else · 1 events · looked at/),
    ).toBeInTheDocument();
    // Not one to import into, nor to make the default.
    expect(
      within(all).queryByRole('button', { name: 'Import a file into Gmail' }),
    ).not.toBeInTheDocument();
    expect(
      within(all).getByRole('button', { name: 'Look at Gmail again' }),
    ).toBeInTheDocument();

    // On the calendar it is there, to be read and not changed.
    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole(
        'link',
        { name: 'Calendar' },
      ),
    );
    const week = await within(await opened()).findByRole('grid', {
      name: 'Week',
    });
    await userEvent.click(
      await within(week).findByRole('button', { name: /Swimming/ }),
    );
    const event = await screen.findByRole('form', { name: 'Event' });
    expect(within(event).getByRole('note')).toHaveTextContent(
      /kept somewhere else/,
    );
    expect(
      within(event).queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
    expect(
      within(event).queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
  });

  it('shows a month, a box to each day, and a day by itself', async () => {
    const backend = await fakeBackend();
    await addEvent(backend, { title: 'Dentist', start: `${today}T14:00:00` });
    await renderApp(backend, `/calendar/month/${today}`);
    const month = await within(await opened()).findByRole('grid', {
      name: 'Month',
    });
    const named = new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    const box = within(month).getByRole('gridcell', { name: named });
    expect(
      await within(box).findByRole('button', { name: /Dentist/ }),
    ).toHaveTextContent('14:00');
    // The number of a day is the way to the day itself.
    await userEvent.click(
      within(box).getByRole('link', { name: `Go to ${named}` }),
    );
    const day = await within(await opened()).findByRole('grid', {
      name: 'Day',
    });
    expect(within(day).getAllByRole('columnheader')).toHaveLength(1);
    expect(
      await within(day).findByRole('button', { name: /Dentist/ }),
    ).toHaveTextContent('14:00 – 15:00');
    expect(
      within(await opened()).getByRole('link', { name: 'Next day' }),
    ).toBeInTheDocument();
  });

  it('writes an event in a form that grows where it stands, and keeps it', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, `/calendar/week/${today}`);
    await within(await opened()).findByRole('grid', { name: 'Week' });
    await userEvent.click(newEvent());
    const form = await screen.findByRole('form', { name: 'New event' });
    // What it starts with: what, when. The rest is there to be added.
    expect(within(form).queryByLabelText('Place')).not.toBeInTheDocument();
    expect(
      within(form).getByText(/Reminder: 30 minutes before/),
    ).toBeInTheDocument();
    await userEvent.type(
      within(form).getByLabelText('Title'),
      'Lunch with Ann',
    );
    // In the last hour of a day, the hour to come is tomorrow's.
    fireEvent.change(within(form).getByLabelText('Day'), {
      target: { value: today },
    });
    fireEvent.change(within(form).getByLabelText('Starts'), {
      target: { value: '13:00' },
    });
    fireEvent.change(within(form).getByLabelText('Ends'), {
      target: { value: '14:00' },
    });
    // While it is written it is on the calendar already, as it would be.
    expect(within(calendar()).getByText('Lunch with Ann')).toBeInTheDocument();

    const add = within(form).getByRole('group', { name: 'Add to the event' });
    await userEvent.click(within(add).getByRole('button', { name: 'Place' }));
    await userEvent.type(within(form).getByLabelText('Place'), 'Luigi’s');
    await userEvent.click(
      within(add).getByRole('button', { name: 'Reminders' }),
    );
    // They start as the calendar's own, and another is one press away.
    expect(within(form).getByLabelText('Reminder 1')).toHaveValue('30');
    await userEvent.click(
      within(form).getByRole('button', { name: 'Add a reminder' }),
    );
    await userEvent.selectOptions(
      within(form).getByLabelText('Reminder 2'),
      '1440',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Added to the calendar'),
    ).toBeInTheDocument();
    expect(
      await within(await opened()).findByRole('button', {
        name: /Lunch with Ann/,
      }),
    ).toHaveTextContent('13:00 – 14:00');
    const [kept] = await events(backend);
    expect(kept).toMatchObject({
      title: 'Lunch with Ann',
      start: `${today}T13:00:00`,
      duration: 'PT1H',
      locations: { '1': { name: 'Luigi’s' } },
      useDefaultAlerts: false,
      alerts: {
        '1': { trigger: { offset: '-PT30M' } },
        '2': { trigger: { offset: '-P1D' } },
      },
    });

    // The next one starts with what this one used.
    await userEvent.click(newEvent());
    expect(
      within(
        await screen.findByRole('form', { name: 'New event' }),
      ).getByLabelText('Place'),
    ).toHaveValue('');
  });

  it('changes an event, deletes it, and puts it back with Undo', async () => {
    const backend = await fakeBackend();
    await addEvent(backend);
    await renderApp(backend, `/calendar/week/${today}`);
    await userEvent.click(
      await within(await opened()).findByRole('button', { name: /Dentist/ }),
    );
    const form = await screen.findByRole('form', { name: 'Event' });
    const title = within(form).getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Dentist, moved');
    fireEvent.change(within(form).getByLabelText('Starts'), {
      target: { value: '16:00' },
    });
    fireEvent.change(within(form).getByLabelText('Ends'), {
      target: { value: '16:30' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(await events(backend)).toMatchObject([
      {
        title: 'Dentist, moved',
        start: `${today}T16:00:00`,
        duration: 'PT30M',
      },
    ]);

    await userEvent.click(
      await within(await opened()).findByRole('button', {
        name: /Dentist, moved/,
      }),
    );
    await userEvent.click(
      within(await screen.findByRole('form', { name: 'Event' })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    expect(
      await screen.findByText('Dentist, moved was deleted'),
    ).toBeInTheDocument();
    expect(await events(backend)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await events(backend)).toHaveLength(1));
    expect(
      await within(await opened()).findByRole('button', {
        name: /Dentist, moved/,
      }),
    ).toBeInTheDocument();
  });

  it('shows an event that repeats each time it is on, and changes one time or every time', async () => {
    const backend = await fakeBackend();
    // From the Monday of this week, every day.
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    await addEvent(backend, {
      title: 'Stand-up',
      start: `${dayKey(monday)}T09:00:00`,
      duration: 'PT30M',
      recurrenceRules: [{ frequency: 'daily' }],
    });
    await renderApp(backend, `/calendar/week/${today}`);
    const week = await within(await opened()).findByRole('grid', {
      name: 'Week',
    });
    await waitFor(() =>
      expect(
        within(week).getAllByRole('button', { name: /Stand-up/ }),
      ).toHaveLength(7),
    );

    // One of them, this once.
    const todays = within(
      within(week).getByRole('gridcell', {
        name: new Date().toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }),
      }),
    );
    await userEvent.click(todays.getByRole('button', { name: /Stand-up/ }));
    let form = await screen.findByRole('form', { name: 'Event' });
    expect(within(form).getByLabelText('This one')).toBeChecked();
    // How it repeats is the whole event's to say.
    expect(within(form).queryByLabelText('Repeats')).not.toBeInTheDocument();
    const title = within(form).getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Stand-up, outside');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        within(week).getAllByRole('button', { name: /^Stand-up09/ }),
      ).toHaveLength(6),
    );
    expect(
      todays.getByRole('button', { name: /Stand-up, outside/ }),
    ).toBeInTheDocument();

    // Every one of them: later in the day, and only until the end of next week.
    await userEvent.click(
      within(week).getAllByRole('button', {
        name: /^Stand-up09/,
      })[0] as HTMLElement,
    );
    form = await screen.findByRole('form', { name: 'Event' });
    await userEvent.click(within(form).getByLabelText('Every one'));
    expect(within(form).getByLabelText('Repeats')).toHaveValue('daily');
    fireEvent.change(within(form).getByLabelText('Starts'), {
      target: { value: '10:00' },
    });
    fireEvent.change(within(form).getByLabelText('Ends'), {
      target: { value: '10:30' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    // All seven, the one that was changed among them: it keeps its name.
    await waitFor(() =>
      expect(
        within(week).getAllByRole('button', { name: /10:00 – 10:30/ }),
      ).toHaveLength(7),
    );
    expect(
      todays.getByRole('button', { name: /Stand-up, outside/ }),
    ).toHaveTextContent('10:00 – 10:30');
    const [kept] = await events(backend);
    expect(kept).toMatchObject({
      title: 'Stand-up',
      start: `${dayKey(monday)}T10:00:00`,
      recurrenceRules: [{ frequency: 'daily' }],
    });

    // One time taken out, and put back.
    await userEvent.click(
      within(week).getAllByRole('button', {
        name: /10:00 – 10:30/,
      })[0] as HTMLElement,
    );
    await userEvent.click(
      within(await screen.findByRole('form', { name: 'Event' })).getByRole(
        'button',
        { name: 'Delete' },
      ),
    );
    await waitFor(() =>
      expect(
        within(week).getAllByRole('button', { name: /10:00 – 10:30/ }),
      ).toHaveLength(6),
    );
    expect(await events(backend)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(
        within(week).getAllByRole('button', { name: /10:00 – 10:30/ }),
      ).toHaveLength(7),
    );
  });

  it('draws an event with the mouse, moves one to another day and time, and pulls one longer', async () => {
    const backend = await fakeBackend();
    await addEvent(backend);
    await renderApp(backend, `/calendar/week/${today}`);
    const week = await within(await opened()).findByRole('grid', {
      name: 'Week',
    });
    // Without a layout every column is a pixel wide and an hour is 48 tall: the
    // pointer says which day by how far across, and which time by how far down.
    const column = (new Date().getDay() + 6) % 7;
    const other = column === 6 ? 5 : column + 1;
    const at = (day: number, hour: number) => ({
      clientX: day + 0.5,
      clientY: hour * 48,
    });
    const days = within(week)
      .getAllByRole('gridcell')
      .filter((cell) => cell.classList.contains('week-day'));

    // Moved: taken hold of half an hour in, and let go on another day at half past four.
    const dentist = await within(week).findByRole('button', {
      name: /Dentist/,
    });
    fireEvent.pointerDown(dentist, at(column, 14.5));
    fireEvent.pointerMove(window, at(other, 16.5));
    // Where it would land is shown while it is held.
    expect(
      within(days[other] as HTMLElement).getByText('16:00 – 17:00'),
    ).toBeInTheDocument();
    fireEvent.pointerUp(window, at(other, 16.5));
    const moved = new Date();
    moved.setDate(moved.getDate() + (other - column));
    await waitFor(async () =>
      expect(await events(backend)).toMatchObject([
        { start: `${dayKey(moved)}T16:00:00`, duration: 'PT1H' },
      ]),
    );
    expect(
      await screen.findByText(/Dentist: .*16:00 – 17:00/),
    ).toBeInTheDocument();
    // And back, with Undo.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () =>
      expect(await events(backend)).toMatchObject([
        { start: `${today}T14:00:00`, duration: 'PT1H' },
      ]),
    );

    // Pulled longer by its lower edge.
    const again = await within(days[column] as HTMLElement).findByRole(
      'button',
      { name: /Dentist/ },
    );
    fireEvent.pointerDown(
      again.querySelector('.week-event-edge') as HTMLElement,
      at(column, 15),
    );
    fireEvent.pointerMove(window, at(column, 16.25));
    fireEvent.pointerUp(window, at(column, 16.25));
    await waitFor(async () =>
      expect(await events(backend)).toMatchObject([
        { start: `${today}T14:00:00`, duration: 'PT2H15M' },
      ]),
    );
    // A press that goes nowhere is a click: it opens the event, and moves nothing.
    expect(screen.queryByRole('form')).not.toBeInTheDocument();

    // Drawn on an empty part of a day, upwards: the form opens on what was drawn.
    fireEvent.pointerDown(days[other] as HTMLElement, at(other, 11.5));
    fireEvent.pointerMove(window, at(other, 10));
    fireEvent.pointerUp(window, at(other, 10));
    const form = await screen.findByRole('form', { name: 'New event' });
    expect(within(form).getByLabelText('Day')).toHaveValue(dayKey(moved));
    expect(within(form).getByLabelText('Starts')).toHaveValue('10:00');
    expect(within(form).getByLabelText('Ends')).toHaveValue('11:30');

    // The one being written is moved where it stands, and the form follows.
    fireEvent.pointerDown(
      within(days[other] as HTMLElement).getByText('New event'),
      at(other, 10),
    );
    fireEvent.pointerMove(window, at(column, 8));
    fireEvent.pointerUp(window, at(column, 8));
    expect(within(form).getByLabelText('Day')).toHaveValue(today);
    expect(within(form).getByLabelText('Starts')).toHaveValue('08:00');
    expect(within(form).getByLabelText('Ends')).toHaveValue('09:30');
    // Nothing was kept by that: it is still being written.
    expect(await events(backend)).toHaveLength(1);
  });

  it('makes an event repeat from the form', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, `/calendar/week/${today}`);
    await within(await opened()).findByRole('grid', { name: 'Week' });
    await userEvent.click(newEvent());
    const form = await screen.findByRole('form', { name: 'New event' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Gym');
    await userEvent.click(
      within(
        within(form).getByRole('group', { name: 'Add to the event' }),
      ).getByRole('button', { name: 'Repeat' }),
    );
    expect(within(form).getByLabelText('Repeats')).toHaveValue('weekly');
    await userEvent.selectOptions(
      within(form).getByLabelText('Repeats'),
      'biweekly',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText('Added to the calendar');
    expect(await events(backend)).toMatchObject([
      {
        title: 'Gym',
        recurrenceRules: [{ frequency: 'weekly', interval: 2 }],
      },
    ]);
  });

  it('lists the days that have something on, and hides a calendar that is switched off', async () => {
    const backend = await fakeBackend();
    await addEvent(backend);
    await addEvent(backend, {
      title: 'Sofia’s birthday',
      start: `${today}T00:00:00`,
      duration: 'P1D',
      timeZone: null,
      showWithoutTime: true,
    });
    await renderApp(backend, `/calendar/agenda/${today}`);
    const day = await within(await opened()).findByRole('region', {
      name: 'Today',
    });
    expect(
      within(day)
        .getAllByRole('button')
        .map((row) => row.textContent),
    ).toEqual(['all daySofia’s birthday', '14:0015:00Dentist']);

    await userEvent.click(
      within(
        screen.getByRole('navigation', { name: 'Calendars' }),
      ).getByLabelText('Personal'),
    );
    expect(await within(day).findByText('Nothing on.')).toBeInTheDocument();
  });

  it('moves an event being written to a window of its own, and shows it from there', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, `/calendar/week/${today}`);
    await within(await opened()).findByRole('grid', { name: 'Week' });
    await userEvent.click(newEvent());
    const form = await screen.findByRole('form', { name: 'New event' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Offsite');

    // The window is handed what was written, as the browser hands a new window what the tab keeps.
    const handed: Array<{ url: string; draft: string | null }> = [];
    const open = vi.spyOn(window, 'open').mockImplementation((url) => {
      const key = new URL(String(url)).searchParams.get('window') ?? '';
      handed.push({
        url: String(url),
        draft: window.sessionStorage.getItem(draftKey(key)),
      });
      return window;
    });
    await userEvent.click(
      within(form).getByRole('button', { name: 'Open in a window of its own' }),
    );
    open.mockRestore();
    expect(handed).toHaveLength(1);
    expect(handed[0]?.url).toContain('/calendar/event?window=');
    expect(JSON.parse(handed[0]?.draft ?? '{}')).toMatchObject({
      title: 'Offsite',
    });
    // It is written elsewhere now, and still where it would be on the calendar.
    expect(
      screen.queryByRole('form', { name: 'New event' }),
    ).not.toBeInTheDocument();
    expect(within(calendar()).getByText('Offsite')).toBeInTheDocument();
  });
});

describe('invitations', () => {
  /** The calendar a message that was sent carries. */
  const carried = (message: string) => {
    const found =
      /text\/calendar[^\n]*\r\n[^\n]*\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(
        message,
      );
    return atob((found?.[1] ?? '').replace(/\s/g, '')).replace(/\r\n /g, '');
  };

  it('asks each time whether the people on an event are to be told, and tells them when asked', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, `/calendar/week/${today}`);
    await within(await opened()).findByRole('grid', { name: 'Week' });
    await userEvent.click(newEvent());
    let form = await screen.findByRole('form', { name: 'New event' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Lunch');
    await userEvent.click(
      within(
        within(form).getByRole('group', { name: 'Add to the event' }),
      ).getByRole('button', { name: 'People' }),
    );
    await userEvent.type(
      within(form).getByRole('combobox', { name: 'People' }),
      'bob@example.net',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    // Not kept yet: first, whether to tell him.
    const ask = within(form).getByRole('alertdialog', {
      name: 'Tell the others?',
    });
    expect(ask).toHaveTextContent('Send this to the people on it?');
    expect(await events(backend)).toEqual([]);
    await userEvent.click(within(ask).getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText(
        'Added to the calendar. The people on it were told.',
      ),
    ).toBeInTheDocument();
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.recipients).toEqual(['bob@example.net']);
    expect(backend.sent[0]?.message).toContain('Subject: Invitation: Lunch');
    const invitation = carried(backend.sent[0]?.message ?? '');
    expect(invitation).toContain('METHOD:REQUEST');
    expect(invitation).toContain('ORGANIZER;CN=Ann:mailto:ann@example.com');

    // Changed, and this time nobody is told.
    await userEvent.click(
      await within(await opened()).findByRole('button', { name: /Lunch/ }),
    );
    form = await screen.findByRole('form', { name: 'Event' });
    expect(
      within(form).getByRole('list', { name: 'People: people' }),
    ).toHaveTextContent('bob@example.net');
    expect(
      within(form).getByRole('list', { name: 'What they answered' }),
    ).toHaveTextContent('bob@example.net · No answer yet');
    await userEvent.type(within(form).getByLabelText('Title'), ' at one');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await userEvent.click(
      within(form).getByRole('button', { name: 'Don’t send' }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(backend.sent).toHaveLength(1);

    // Deleted, and he is told that it is off.
    await userEvent.click(
      await within(await opened()).findByRole('button', {
        name: /Lunch at one/,
      }),
    );
    form = await screen.findByRole('form', { name: 'Event' });
    await userEvent.click(within(form).getByRole('button', { name: 'Delete' }));
    expect(
      within(form).getByRole('alertdialog', { name: 'Tell the others?' }),
    ).toHaveTextContent('Tell the people on it that it is cancelled?');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(backend.sent).toHaveLength(2));
    expect(backend.sent[1]?.message).toContain(
      'Subject: Cancelled: Lunch at one',
    );
    // What was said cannot be unsaid: there is nothing to undo.
    expect(
      await screen.findByText(
        'Lunch at one was deleted, and the others were told',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Undo' }),
    ).not.toBeInTheDocument();
  });

  it('offers the people of the address book, and where they are, as an event is written', async () => {
    const backend = await fakeBackend();
    const [{ id: bookId }] = (
      (await backend.server.handleRequest(
        {
          using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
          methodCalls: [['AddressBook/get', { accountId: 'ann' }, 'b']],
        },
        AUTH,
      )) as unknown as {
        methodResponses: [string, { list: Array<{ id: string }> }][];
      }
    ).methodResponses[0]?.[1].list as [{ id: string }];
    await backend.server.handleRequest(
      {
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'],
        methodCalls: [
          [
            'ContactCard/set',
            {
              accountId: 'ann',
              create: {
                c: {
                  addressBookIds: { [bookId]: true },
                  name: { full: 'Bob Builder' },
                  emails: { '1': { address: 'bob@example.net' } },
                  addresses: { '1': { full: '12 Yard Lane\nSpringfield' } },
                },
              },
            },
            'c',
          ],
        ],
      },
      AUTH,
    );
    await addEvent(backend, {
      title: 'Earlier',
      locations: { '1': { '@type': 'Location', name: 'Luigi’s' } },
    });
    await renderApp(backend, `/calendar/week/${today}`);
    await within(await opened()).findByRole('button', { name: /Earlier/ });
    await userEvent.click(newEvent());
    const form = await screen.findByRole('form', { name: 'New event' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Site visit');
    const add = within(form).getByRole('group', { name: 'Add to the event' });

    // Who: found by the start of a name, and known by it from then on.
    await userEvent.click(within(add).getByRole('button', { name: 'People' }));
    const people = within(form).getByRole('combobox', { name: 'People' });
    await userEvent.type(people, 'bui');
    await userEvent.click(
      await within(form).findByRole('option', { name: /Bob Builder/ }),
    );
    expect(
      within(form).getByRole('list', { name: 'People: people' }),
    ).toHaveTextContent('Bob Builder');
    // Someone the address book does not know is typed out, and is who they are by their address.
    await userEvent.type(people, 'carol@example.org,');
    expect(
      within(form).getByRole('list', { name: 'People: people' }),
    ).toHaveTextContent('carol@example.org');
    // Half an address is nobody yet, and is said to be.
    await userEvent.type(people, 'dave');
    expect(
      within(form).getByText('“dave” is not an address yet.'),
    ).toBeInTheDocument();
    await userEvent.clear(people);

    // Where: where an event was before, and where someone in the address book is.
    await userEvent.click(within(add).getByRole('button', { name: 'Place' }));
    const place = within(form).getByLabelText('Place');
    const offered = [
      ...(form.querySelectorAll(
        '#event-places option',
      ) as NodeListOf<HTMLOptionElement>),
    ].map((option) => [option.value, option.textContent]);
    expect(offered).toEqual([
      ['Luigi’s', ''],
      ['12 Yard Lane, Springfield', 'Bob Builder'],
    ]);
    await userEvent.type(place, '12 Yard Lane, Springfield');

    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(backend.sent).toHaveLength(1));
    expect(backend.sent[0]?.recipients).toEqual([
      'bob@example.net',
      'carol@example.org',
    ]);
    const invitation = carried(backend.sent[0]?.message ?? '');
    expect(invitation).toContain(
      'ATTENDEE;CN=Bob Builder;ROLE=REQ-PARTICIPANT',
    );
    expect(invitation).toContain('LOCATION:12 Yard Lane\\, Springfield');
  });

  it('shows an invitation above the message it came with, answers it, and puts it in the calendar', async () => {
    const backend = await fakeBackend();
    // From one to half past two today, by the clock here, said in the world's time as other calendars say it.
    const from = new Date(`${today}T13:00:00`);
    const until = new Date(`${today}T14:30:00`);
    const stamp = (date: Date) =>
      `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
    const calendar = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:review@example.org',
      'SUMMARY:Quarterly review',
      `DTSTART:${stamp(from)}`,
      `DTEND:${stamp(until)}`,
      'LOCATION:Room 2',
      'ORGANIZER;CN=Marta:mailto:marta@example.org',
      'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ann@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    await backend.deliver({
      raw: [
        'From: Marta <marta@example.org>',
        'To: ann@example.com',
        'Subject: Invitation: Quarterly review',
        'Message-ID: <inv1@example.org>',
        'Date: Mon, 5 Jan 2026 09:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Marta invites you.',
        '--b',
        'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
        '',
        calendar,
        '--b--',
        '',
      ].join('\r\n'),
    });
    await renderApp(backend);
    await userEvent.click(
      await screen.findByRole('link', { name: /Quarterly review/ }),
    );
    const card = await screen.findByRole('note', { name: 'Invitation' });
    expect(card).toHaveTextContent('Quarterly review');
    expect(card).toHaveTextContent('13:00 – 14:30');
    expect(card).toHaveTextContent('Room 2');
    // Nothing is in the calendar until it is answered.
    expect(await events(backend)).toEqual([]);

    await userEvent.click(within(card).getByRole('button', { name: 'Yes' }));
    expect(
      await screen.findByText(
        'marta@example.org was told: yes. It is in your calendar.',
      ),
    ).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Yes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.recipients).toEqual(['marta@example.org']);
    expect(backend.sent[0]?.message).toContain(
      'Subject: Accepted: Quarterly review',
    );
    expect(carried(backend.sent[0]?.message ?? '')).toContain(
      'PARTSTAT=ACCEPTED:mailto:ann@example.com',
    );
    expect(await events(backend)).toMatchObject([
      {
        title: 'Quarterly review',
        start: from.toISOString().slice(0, 19),
        timeZone: 'Etc/UTC',
      },
    ]);

    // Thought better of: the same event, another answer, and Marta is told again.
    await userEvent.click(within(card).getByRole('button', { name: 'Maybe' }));
    await waitFor(() => expect(backend.sent).toHaveLength(2));
    expect(backend.sent[1]?.message).toContain(
      'Subject: Maybe: Quarterly review',
    );
    expect(await events(backend)).toHaveLength(1);
  });
});

describe('another time, suggested', () => {
  const carried = (message: string) => {
    const found =
      /text\/calendar[^\n]*\r\n[^\n]*\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(
        message,
      );
    return atob((found?.[1] ?? '').replace(/\s/g, '')).replace(/\r\n /g, '');
  };
  const stamp = (date: Date) =>
    `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  /** A message from someone's calendar, as it arrives. */
  const mail = (
    from: string,
    subject: string,
    method: string,
    lines: string[],
  ) =>
    [
      `From: ${from}`,
      'To: ann@example.com',
      `Subject: ${subject}`,
      `Message-ID: <${method}-${subject.length}@example.net>`,
      'Date: Mon, 5 Jan 2026 09:00:00 +0000',
      'MIME-Version: 1.0',
      `Content-Type: text/calendar; charset=utf-8; method=${method}`,
      '',
      [
        'BEGIN:VCALENDAR',
        `METHOD:${method}`,
        'BEGIN:VEVENT',
        ...lines,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    ].join('\r\n');

  it('is shown to whoever the event is from, who takes it up or keeps the time', async () => {
    const backend = await fakeBackend();
    await addEvent(backend, {
      uid: 'lunch@example.com',
      title: 'Lunch',
      start: `${today}T13:00:00`,
      replyTo: { imip: 'mailto:ann@example.com' },
      participants: {
        me: {
          email: 'ann@example.com',
          roles: { owner: true, attendee: true },
        },
        bob: {
          email: 'bob@example.net',
          sendTo: { imip: 'mailto:bob@example.net' },
          participationStatus: 'needs-action',
          roles: { attendee: true },
        },
      },
    });
    const from = new Date(`${today}T15:00:00`);
    const until = new Date(`${today}T16:00:00`);
    const suggestion = (subject: string) =>
      mail('Bob <bob@example.net>', subject, 'COUNTER', [
        'UID:lunch@example.com',
        'SUMMARY:Lunch',
        `DTSTART:${stamp(from)}`,
        `DTEND:${stamp(until)}`,
        'ORGANIZER:mailto:ann@example.com',
        'ATTENDEE;PARTSTAT=TENTATIVE:mailto:bob@example.net',
        'COMMENT:Three suits me better',
      ]);
    await backend.deliver({ raw: suggestion('Another time: Lunch') });
    await backend.deliver({ raw: suggestion('Another time again: Lunch') });
    await renderApp(backend);

    // Kept as it is: he is told so, and nothing moves.
    await userEvent.click(
      await screen.findByRole('link', { name: /Another time again: Lunch/ }),
    );
    let card = await screen.findByRole('note', {
      name: 'Another time suggested',
    });
    expect(card).toHaveTextContent('bob@example.net suggests another time for');
    expect(card).toHaveTextContent('15:00 – 16:00');
    expect(card).toHaveTextContent('As it stands:');
    expect(card).toHaveTextContent('“Three suits me better”');
    await userEvent.click(
      within(card).getByRole('button', { name: 'Keep the time' }),
    );
    expect(
      await within(card).findByText(
        'bob@example.net was told the time is kept.',
      ),
    ).toBeInTheDocument();
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.recipients).toEqual(['bob@example.net']);
    expect(carried(backend.sent[0]?.message ?? '')).toContain(
      'METHOD:DECLINECOUNTER',
    );
    expect(await events(backend)).toMatchObject([
      { start: `${today}T13:00:00` },
    ]);

    // Taken up: the event moves, and whether the others are told is asked as for any change.
    await userEvent.click(
      screen.getByRole('link', { name: /Another time: Lunch/ }),
    );
    card = await screen.findByRole('note', { name: 'Another time suggested' });
    await userEvent.click(
      within(card).getByRole('button', { name: 'Use this time' }),
    );
    expect(
      within(card).getByRole('alertdialog', { name: 'Tell the others?' }),
    ).toHaveTextContent('Send the new time to the people on it?');
    await userEvent.click(within(card).getByRole('button', { name: 'Send' }));
    expect(
      await within(card).findByText(
        'The event was moved, and the people on it were told.',
      ),
    ).toBeInTheDocument();
    expect(await events(backend)).toMatchObject([
      { start: `${today}T15:00:00`, duration: 'PT1H' },
    ]);
    expect(backend.sent).toHaveLength(2);
    expect(backend.sent[1]?.message).toContain(
      'Subject: Updated invitation: Lunch',
    );
    expect(carried(backend.sent[1]?.message ?? '')).toContain(
      `DTSTART:${stamp(from)}`,
    );
  });

  it('is sent to whoever invited, from the invitation, which is answered maybe by that', async () => {
    const backend = await fakeBackend();
    const from = new Date(`${today}T13:00:00`);
    const until = new Date(`${today}T14:30:00`);
    await backend.deliver({
      raw: mail('Marta <marta@example.org>', 'Invitation: Review', 'REQUEST', [
        'UID:review@example.org',
        'SUMMARY:Review',
        `DTSTART:${stamp(from)}`,
        `DTEND:${stamp(until)}`,
        'ORGANIZER:mailto:marta@example.org',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ann@example.com',
      ]),
    });
    await renderApp(backend);
    await userEvent.click(
      await screen.findByRole('link', { name: /Invitation: Review/ }),
    );
    const card = await screen.findByRole('note', { name: 'Invitation' });
    await userEvent.click(
      within(card).getByRole('button', { name: 'Suggest another time' }),
    );
    const form = within(card).getByRole('group', {
      name: 'Suggest another time',
    });
    // It starts at the time that was asked for, to be changed from there.
    expect(within(form).getByLabelText('Suggested start')).toHaveValue('13:00');
    fireEvent.change(within(form).getByLabelText('Suggested start'), {
      target: { value: '16:00' },
    });
    fireEvent.change(within(form).getByLabelText('Suggested end'), {
      target: { value: '17:00' },
    });
    await userEvent.type(
      within(form).getByLabelText('A word to go with it'),
      'I am in a meeting until four',
    );
    await userEvent.click(
      within(form).getByRole('button', { name: 'Send the suggestion' }),
    );
    expect(
      await screen.findByText('marta@example.org was sent your suggestion'),
    ).toBeInTheDocument();
    // Two messages: that it is a maybe, and when it would suit.
    expect(backend.sent.map((each) => each.recipients)).toEqual([
      ['marta@example.org'],
      ['marta@example.org'],
    ]);
    expect(backend.sent[0]?.message).toContain('Subject: Maybe: Review');
    expect(backend.sent[1]?.message).toContain(
      'Subject: Another time suggested: Review',
    );
    const counter = carried(backend.sent[1]?.message ?? '');
    expect(counter).toContain('METHOD:COUNTER');
    expect(counter).toContain(
      `DTSTART:${stamp(new Date(`${today}T16:00:00`))}`,
    );
    expect(counter).toContain('COMMENT:I am in a meeting until four');
    // In the calendar as it was asked for, not as it was suggested.
    expect(await events(backend)).toMatchObject([
      { title: 'Review', start: from.toISOString().slice(0, 19) },
    ]);
    expect(within(card).getByRole('button', { name: 'Maybe' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('the calendars, in the settings', () => {
  it('are made, named, made the default and removed', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    const settings = await screen.findByRole('region', { name: 'Settings' });
    const all = await within(settings).findByRole('list', {
      name: 'Your calendars',
    });
    expect(within(all).getByText('Personal')).toBeInTheDocument();
    expect(within(all).getByText('Default')).toBeInTheDocument();
    // The only one there is cannot be removed.
    expect(
      within(all).queryByRole('button', { name: /Delete the calendar/ }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(settings).getByRole('button', { name: 'New calendar' }),
    );
    await userEvent.type(
      within(settings).getByLabelText('Name of the new calendar'),
      'Work',
    );
    await userEvent.click(
      within(settings).getByRole('radio', { name: 'Green' }),
    );
    await userEvent.click(
      within(settings).getByRole('button', { name: 'Add' }),
    );
    expect(await within(all).findByText('Work')).toBeInTheDocument();
    await userEvent.click(
      within(all).getByRole('button', { name: 'Make default' }),
    );
    expect(
      await screen.findByText('New events go in Work'),
    ).toBeInTheDocument();
    const kept = (await call(backend, 'Calendar/get', { ids: null }))[
      'list'
    ] as Array<{ name: string; color: string; isDefault: boolean }>;
    expect(
      kept.map(({ name, color, isDefault }) => ({ name, color, isDefault })),
    ).toEqual([
      { name: 'Personal', color: '#2456c8', isDefault: false },
      { name: 'Work', color: '#1e7b4a', isDefault: true },
    ]);

    await userEvent.click(
      within(all).getByRole('button', {
        name: 'Delete the calendar Personal',
      }),
    );
    await userEvent.click(
      within(all).getByRole('button', {
        name: 'Delete the calendar and its events',
      }),
    );
    await waitFor(() =>
      expect(within(all).queryByText('Personal')).not.toBeInTheDocument(),
    );
  });
});

describe('an event in a window of its own', () => {
  afterEach(() => window.sessionStorage.clear());

  it('goes on from what was written, and keeps it', async () => {
    const backend = await fakeBackend();
    const [{ id }] = (await call(backend, 'Calendar/get', { ids: null }))[
      'list'
    ] as Array<{ id: string }>;
    window.sessionStorage.setItem(
      draftKey('k1'),
      JSON.stringify({
        ...newForm(id as string, new Date(`${today}T10:00:00`)),
        title: 'Offsite',
      }),
    );
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    await renderApp(backend, '/calendar/event?window=k1');

    const form = await screen.findByRole('form', { name: 'New event' });
    expect(within(form).getByLabelText('Title')).toHaveValue('Offsite');
    // It is in a window already: there is none to move it to.
    expect(
      within(form).queryByRole('button', {
        name: 'Open in a window of its own',
      }),
    ).not.toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Title'), ' planning');
    // Kept for the window as it is written, so that reloading loses nothing.
    await waitFor(() =>
      expect(
        JSON.parse(window.sessionStorage.getItem(draftKey('k1')) ?? '{}'),
      ).toMatchObject({ title: 'Offsite planning' }),
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(await events(backend)).toMatchObject([
      { title: 'Offsite planning', start: `${today}T10:00:00` },
    ]);
    expect(window.sessionStorage.getItem(draftKey('k1'))).toBeNull();
    close.mockRestore();
  });

  it('says so when nothing is being written in it', async () => {
    await renderApp(await fakeBackend(), '/calendar/event?window=none');
    expect(
      await screen.findByText(
        'There is no event being written in this window.',
      ),
    ).toBeInTheDocument();
  });
});
