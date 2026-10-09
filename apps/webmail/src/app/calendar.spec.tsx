import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dayKey, draftKey, newForm } from '../lib/calendar';
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
