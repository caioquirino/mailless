import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Button, Icon, IconButton } from '@mailless/ui';
import {
  CHANNEL,
  Calendars,
  addDays,
  dayKey,
  dayOf,
  draftKey,
  formOf,
  formSpan,
  newForm,
  placeDay,
  readDraft,
  timeOf,
  weekStart,
  withSpan,
  weekTitle,
  type Answer,
  type CalendarEvent,
  type EventForm,
  type Shown,
  type WindowMessage,
} from '../lib/calendar';
import { appBaseUrl } from '../lib/config';
import { ANSWER_WORDS, EventEditor } from './event-editor';
import { Rail } from './rail';
import { useMail, useServices, useSynced, withUndo } from './services';

export type CalendarView = 'week' | 'agenda';

/** How tall an hour is in the week, in pixels. */
const HOUR = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** How far ahead the agenda looks. */
const AGENDA_DAYS = 60;

const tinted = (color: string) => ({ '--event': color }) as React.CSSProperties;

const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);

/** What an event is called where it is shown. */
const titleOf = (event: Pick<CalendarEvent, 'title'>) =>
  event.title?.trim() || '(no title)';

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(CHANNEL)
    : null;
}

export interface CalendarPageProps {
  view: CalendarView;
  /** The day the view is at, as `2026-10-09`. Today when left out. */
  date?: string | undefined;
  menu: boolean;
  folded: boolean;
  onCloseMenu(): void;
}

export function CalendarPage(props: CalendarPageProps) {
  const { view, menu, folded, onCloseMenu } = props;
  const { store, act, say } = useMail();
  const calendar = store.calendar;
  useSynced(calendar.calendars);
  useSynced(calendar.events);
  useSynced(calendar);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  /** The event being written here, beside the calendar. */
  const [writing, setWriting] = useState<{
    key: string;
    form: EventForm;
  } | null>(null);
  /** The events being written in windows of their own, by the key of each. */
  const [away, setAway] = useState<ReadonlyMap<string, EventForm>>(new Map());
  const [busy, setBusy] = useState(false);
  const made = useRef(0);

  useEffect(() => {
    let current = true;
    calendar.start().then(
      () => current && setState('ready'),
      () => current && setState('failed'),
    );
    return () => {
      current = false;
    };
  }, [calendar]);

  // What the other windows say: where an event being written would be, and when it was kept.
  useEffect(() => {
    const heard = channel();
    if (!heard) return undefined;
    heard.onmessage = ({ data }: MessageEvent<WindowMessage>) => {
      setAway((before) => {
        const next = new Map(before);
        if (data.kind === 'writing') next.set(data.key, data.form);
        else next.delete(data.key);
        return next;
      });
      if (data.kind === 'kept') void calendar.refresh().catch(() => undefined);
    };
    return () => heard.close();
  }, [calendar]);

  // Looked at again after a while: another device may have changed it.
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState === 'visible') {
        void calendar.refresh().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, [calendar]);

  const day = dayOf(props.date);
  const today = dayOf(undefined);
  // The time looked at: the view, and the month beside it, whichever reaches further.
  const month = weekStart(new Date(day.getFullYear(), day.getMonth(), 1));
  const first = Math.min(
    month.getTime(),
    (view === 'week' ? weekStart(day) : day).getTime(),
  );
  const last = Math.max(
    addDays(month, 42).getTime(),
    (view === 'week'
      ? addDays(weekStart(day), 7)
      : addDays(day, AGENDA_DAYS)
    ).getTime(),
  );
  useEffect(() => {
    if (state !== 'ready') return;
    void act(() => calendar.watch(new Date(first), new Date(last)));
  }, [calendar, act, state, first, last]);
  const to = (where: Date, as: CalendarView = view) =>
    `/calendar/${as}/${dayKey(where)}`;
  const step = view === 'week' ? 7 : 30;

  const write = (form: EventForm) =>
    setWriting({ key: `e${Date.now()}-${++made.current}`, form });
  const writeNew = (start?: Date, end?: Date, allDay = false) => {
    const into = calendar.defaultCalendar();
    if (!into) return;
    let from = start;
    if (!from) {
      // The next whole hour of the day being looked at, or of today.
      from =
        sameDay(day, today) || view === 'agenda' ? new Date() : new Date(day);
      from.setHours(sameDay(from, today) ? from.getHours() + 1 : 9, 0, 0, 0);
    }
    write(newForm(into.id, from, end, allDay));
  };
  const save = async (tell: boolean) => {
    if (!writing) return;
    setBusy(true);
    const { form } = writing;
    const kept = await act(() => calendar.save(form, tell));
    setBusy(false);
    if (!kept) return;
    setWriting(null);
    say(
      `${form.id === null ? 'Added to the calendar' : 'Saved'}${tell ? '. The people on it were told.' : ''}`,
    );
  };
  const answer = async (reply: Answer) => {
    if (!writing?.form.invited) return;
    const { key, form } = writing;
    setBusy(true);
    const told = await act(() =>
      calendar.answer(form.series?.id ?? (form.id as string), reply),
    );
    setBusy(false);
    if (!told || !form.invited) return;
    setWriting({
      key,
      form: { ...form, invited: { ...form.invited, answer: reply } },
    });
    say(`${form.invited.by} was told: ${ANSWER_WORDS[reply]?.toLowerCase()}`);
  };
  const remove = async (form: EventForm, tell: boolean) => {
    if (form.id === null) return;
    setBusy(true);
    let back: (() => Promise<void>) | null = null;
    const gone = await act(async () => {
      back = await calendar.remove(
        {
          id: form.id as string,
          ...(form.series ? { baseEventId: form.series.id } : {}),
        },
        form.series?.all ?? false,
        tell,
      );
    });
    setBusy(false);
    if (!gone) return;
    setWriting(null);
    say(
      `${form.title.trim() || 'The event'} was deleted${tell ? ', and the others were told' : ''}`,
      // What was said to the others cannot be unsaid: only what was not said is taken back.
      tell ? {} : withUndo({ act, say }, back),
    );
  };
  /** An event to change: one of the times of one that repeats knows the event it is a time of. */
  const open = (event: CalendarEvent) =>
    write(
      formOf(
        event,
        event.baseEventId ? calendar.events.get(event.baseEventId) : undefined,
        calendar.own,
      ),
    );
  const popOut = () => {
    if (!writing) return;
    const { key, form } = writing;
    try {
      // The new window starts with a copy of what this one keeps for the tab: the form, and who is signed in.
      window.sessionStorage.setItem(draftKey(key), JSON.stringify(form));
      const opened = window.open(
        new URL(
          `calendar/event?window=${encodeURIComponent(key)}`,
          appBaseUrl(),
        ).href,
        `mailless-event-${key}`,
        'popup,width=520,height=720',
      );
      window.sessionStorage.removeItem(draftKey(key));
      if (!opened) {
        say(
          'The browser did not let the window open. Allow pop-ups for this site.',
        );
        return;
      }
    } catch {
      return;
    }
    setAway((before) => new Map(before).set(key, form));
    setWriting(null);
  };

  /** What is being written, here or in another window, as it would be on the calendar. */
  /** What is being written, here and in other windows, as it would be on the calendar. */
  const mine = writing
    ? { form: writing.form, ...formSpan(writing.form) }
    : null;
  const others = [...away.values()].map((form) => ({
    form,
    ...formSpan(form),
  }));
  /** An event dragged to another time, or pulled to another length: kept at once, with a way back. */
  const move = async (event: CalendarEvent, from: Date, until: Date) => {
    const whole = event.baseEventId
      ? calendar.events.get(event.baseEventId)
      : undefined;
    const before = formOf(event, whole, calendar.own);
    const moved = await act(() => calendar.save(withSpan(before, from, until)));
    if (!moved) return;
    say(
      `${titleOf(event)}: ${from.toLocaleDateString(undefined, { weekday: 'long' })}, ${timeOf(from)} – ${timeOf(until)}`,
      withUndo({ act, say }, async () => {
        // Back to when it was, from wherever it is now.
        await calendar.save({ ...before, id: event.id });
      }),
    );
  };

  const side = (
    <div
      className={`side side-calendars${menu ? ' side-open' : ''}${folded ? ' side-folded' : ''}`}
    >
      <button
        type="button"
        className="button write"
        disabled={state !== 'ready'}
        onClick={() => writeNew()}
      >
        <Icon name="plus" />
        <span className="write-label">New event</span>
      </button>
      {menu ? (
        <button
          type="button"
          className="side-backdrop"
          aria-label="Close the list of calendars"
          onClick={onCloseMenu}
        />
      ) : null}
      <nav className="sidebar" aria-label="Calendars">
        <MiniMonth
          day={day}
          busy={(date) => calendar.between(date, addDays(date, 1)).length > 0}
          to={(date) => to(date)}
          onGo={onCloseMenu}
        />
        <h2 className="side-heading">Calendars</h2>
        <ul className="calendar-list">
          {calendar.all().map((each) => (
            <li key={each.id}>
              <label className="calendar-row" style={tinted(each.color ?? '')}>
                <input
                  type="checkbox"
                  checked={each.isVisible}
                  onChange={(event) =>
                    void act(() =>
                      calendar.setVisible(each.id, event.target.checked),
                    )
                  }
                />
                <span className="calendar-name">{each.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </nav>
      <Rail />
    </div>
  );

  const title =
    view === 'week'
      ? weekTitle(weekStart(day))
      : day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <>
      {side}
      <section
        className={`calendar${writing ? ' calendar-writing' : ''}`}
        aria-label="Calendar"
      >
        <div
          className="toolbar calendar-bar"
          role="toolbar"
          aria-label="Calendar"
        >
          <Link className="button button-small" to={to(today)}>
            Today
          </Link>
          <Link
            className="icon-button"
            to={to(addDays(day, -step))}
            aria-label={view === 'week' ? 'Previous week' : 'Earlier'}
            title={view === 'week' ? 'Previous week' : 'Earlier'}
          >
            <Icon name="chevron-left" />
          </Link>
          <Link
            className="icon-button"
            to={to(addDays(day, step))}
            aria-label={view === 'week' ? 'Next week' : 'Later'}
            title={view === 'week' ? 'Next week' : 'Later'}
          >
            <Icon name="chevron-right" />
          </Link>
          <h1 className="calendar-title">{title}</h1>
          <span className="calendar-views" role="group" aria-label="View">
            {(['week', 'agenda'] as const).map((each) => (
              <Link
                key={each}
                to={to(day, each)}
                className={`calendar-view${each === view ? ' current' : ''}`}
                {...(each === view ? { 'aria-current': 'page' as const } : {})}
              >
                {each === 'week' ? 'Week' : 'Agenda'}
              </Link>
            ))}
          </span>
        </div>
        {state === 'failed' ? (
          <p className="notice notice-error pad" role="alert">
            The calendar could not be loaded. Reload the page to try again.
          </p>
        ) : state === 'loading' ? (
          <p role="status" className="muted pad">
            Loading…
          </p>
        ) : !calendar.available ? (
          <p className="muted pad">This server keeps no calendar.</p>
        ) : view === 'week' ? (
          <Week
            start={weekStart(day)}
            today={today}
            events={calendar.between(
              weekStart(day),
              addDays(weekStart(day), 7),
            )}
            mine={mine}
            away={others}
            onMove={(event, from, until) => void move(event, from, until)}
            onMine={(from, until) => {
              if (writing) {
                setWriting({
                  key: writing.key,
                  form: withSpan(writing.form, from, until),
                });
              }
            }}
            colorOf={(event) => calendar.colorOf(event)}
            onOpen={open}
            onNew={writeNew}
          />
        ) : (
          <Agenda
            from={day}
            today={today}
            events={calendar.between(day, addDays(day, AGENDA_DAYS))}
            colorOf={(event) => calendar.colorOf(event)}
            onOpen={open}
          />
        )}
        <button
          type="button"
          className="calendar-add"
          aria-label="New event"
          disabled={state !== 'ready'}
          onClick={() => writeNew()}
        >
          <Icon name="plus" size={26} />
        </button>
      </section>
      {writing ? (
        <div className="event-dock">
          <EventEditor
            key={writing.key}
            form={writing.form}
            calendars={calendar.all()}
            busy={busy}
            own={calendar.own}
            onChange={(form) => setWriting({ key: writing.key, form })}
            onSave={(tell) => void save(tell)}
            onClose={() => setWriting(null)}
            onPopOut={popOut}
            onAnswer={(reply) => void answer(reply)}
            {...(writing.form.id !== null
              ? { onDelete: (tell: boolean) => void remove(writing.form, tell) }
              : {})}
          />
        </div>
      ) : null}
    </>
  );
}

/** A month to find a day in, and go to it. */
function MiniMonth(props: {
  day: Date;
  busy(date: Date): boolean;
  to(date: Date): string;
  onGo(): void;
}) {
  const [month, setMonth] = useState(
    () => new Date(props.day.getFullYear(), props.day.getMonth(), 1),
  );
  // Going somewhere else in the calendar takes the month along.
  const at = dayKey(props.day).slice(0, 7);
  useEffect(() => {
    setMonth(new Date(props.day.getFullYear(), props.day.getMonth(), 1));
    // The month is what is followed, not each day of it.
  }, [at]);
  const first = weekStart(month);
  const today = dayOf(undefined);
  const week = weekStart(props.day);
  const cells = Array.from({ length: 42 }, (_, index) => addDays(first, index));
  const move = (months: number) =>
    setMonth(new Date(month.getFullYear(), month.getMonth() + months, 1));
  return (
    <div className="mini-month">
      <div className="mini-head">
        <strong>
          {month.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          })}
        </strong>
        <IconButton
          icon="chevron-left"
          label="Previous month"
          onClick={() => move(-1)}
        />
        <IconButton
          icon="chevron-right"
          label="Next month"
          onClick={() => move(1)}
        />
      </div>
      <div className="mini-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((letter, index) => (
          <span key={index} className="mini-letter" aria-hidden="true">
            {letter}
          </span>
        ))}
        {cells.map((date) => (
          <Link
            key={dayKey(date)}
            to={props.to(date)}
            onClick={props.onGo}
            className={[
              'mini-day',
              date.getMonth() !== month.getMonth() && 'mini-other',
              sameDay(date, today) && 'mini-today',
              date >= week && date < addDays(week, 7) && 'mini-week',
              props.busy(date) && 'mini-busy',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={date.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
            {...(sameDay(date, today)
              ? { 'aria-current': 'date' as const }
              : {})}
          >
            {date.getDate()}
          </Link>
        ))}
      </div>
    </div>
  );
}

interface Draft {
  form: EventForm;
  start: Date;
  end: Date;
}

/** Where in a day a span of time is, as the top and height of a block. */
function block(day: Date, start: Date, end: Date) {
  const from = Math.max(0, (start.getTime() - day.getTime()) / 3_600_000);
  const until = Math.min(24, (end.getTime() - day.getTime()) / 3_600_000);
  return { top: from * HOUR, height: Math.max(18, (until - from) * HOUR) };
}

/** How finely a time is set by dragging, in minutes. */
const STEP = 15;
/** How far the pointer goes, in pixels, before a press is a drag and not a click. */
const SLACK = 4;

/** What is being done with the pointer held down, in the week. */
interface Drag {
  /** Drawing a new event, moving one, or pulling its end. */
  kind: 'draw' | 'move' | 'resize';
  /** The event, or `draft` for the one being written. Nothing for one being drawn. */
  what: CalendarEvent | 'draft' | null;
  /** Where the pointer went down. */
  x: number;
  y: number;
  /** How far into what is moved it was taken hold of, in minutes. */
  held: number;
  /** How long what is moved is, in minutes. */
  length: number;
  /** For drawing and pulling: the moment that stays put. */
  anchor: Date;
  /** Where it would be if let go now. Null until the pointer has gone far enough. */
  start: Date | null;
  end: Date | null;
}

function Week(props: {
  start: Date;
  today: Date;
  events: readonly Shown[];
  /** The event being written beside the calendar: it can be moved and pulled where it stands. */
  mine: Draft | null;
  /** Those being written in other windows, shown where they would be. */
  away: readonly Draft[];
  colorOf(event: CalendarEvent): string;
  onOpen(event: CalendarEvent): void;
  onNew(start?: Date, end?: Date, allDay?: boolean): void;
  /** An event was dragged to another time, or to another length. */
  onMove(event: CalendarEvent, start: Date, end: Date): void;
  /** The same, for the event being written. */
  onMine(start: Date, end: Date): void;
}) {
  const { start, today, events } = props;
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const hours = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Opened at the morning, not at midnight.
  useEffect(() => {
    if (hours.current) hours.current.scrollTop = 7 * HOUR;
  }, []);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const ticking = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(ticking);
  }, []);
  const within = (each: { start: Date; end: Date }, day: Date) =>
    each.end.getTime() > day.getTime() &&
    each.start.getTime() < addDays(day, 1).getTime();
  const wholeDays = events.filter((each) => each.allDay);

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragging = useRef<Drag | null>(null);
  dragging.current = drag;
  /** A drag has just ended: the click that follows a press is not one. */
  const dragged = useRef(false);
  const said = useRef(props);
  said.current = props;

  /** The moment under the pointer, to the nearest step: which day by where across, which time by how far down. */
  const momentAt = (x: number, y: number): Date => {
    const box = body.current?.getBoundingClientRect();
    const first = body.current?.querySelector<HTMLElement>('.week-day');
    const left = first?.getBoundingClientRect().left ?? box?.left ?? 0;
    const width = first?.getBoundingClientRect().width || 1;
    const column = Math.max(0, Math.min(6, Math.floor((x - left) / width)));
    const minutes = Math.max(
      0,
      Math.min(24 * 60, ((y - (box?.top ?? 0)) / HOUR) * 60),
    );
    const moment = new Date(addDays(start, column));
    moment.setHours(0, Math.round(minutes / STEP) * STEP, 0, 0);
    return moment;
  };

  useEffect(() => {
    if (!drag) return undefined;
    const move = (event: PointerEvent) => {
      const held = dragging.current;
      if (!held) return;
      if (
        held.start === null &&
        Math.hypot(event.clientX - held.x, event.clientY - held.y) < SLACK
      ) {
        return;
      }
      const at = momentAt(event.clientX, event.clientY);
      let from: Date;
      let until: Date;
      if (held.kind === 'move') {
        from = new Date(at.getTime() - held.held * 60_000);
        until = new Date(from.getTime() + held.length * 60_000);
      } else if (held.kind === 'resize') {
        from = held.anchor;
        until = new Date(
          Math.max(at.getTime(), held.anchor.getTime() + STEP * 60_000),
        );
      } else {
        // Drawn upwards as well as downwards, from where it was begun.
        from = at < held.anchor ? at : held.anchor;
        until = at < held.anchor ? held.anchor : at;
        if (until.getTime() === from.getTime()) {
          until = new Date(from.getTime() + STEP * 60_000);
        }
      }
      setDrag({ ...held, start: from, end: until });
    };
    const up = () => {
      const held = dragging.current;
      setDrag(null);
      if (!held || held.start === null || held.end === null) return;
      dragged.current = true;
      // The click this press ends with comes next, and is let through to nothing.
      window.setTimeout(() => {
        dragged.current = false;
      }, 0);
      if (held.kind === 'draw') said.current.onNew(held.start, held.end);
      else if (held.what === 'draft') said.current.onMine(held.start, held.end);
      else if (held.what) said.current.onMove(held.what, held.start, held.end);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', escape);
    };
    // Listened for while something is held, whatever it is: what is held is read as it is then.
  }, [drag !== null]);

  /** Takes hold of something. A finger is left to scroll the page: this is for a mouse. */
  const hold = (
    event: React.PointerEvent,
    kind: Drag['kind'],
    what: Drag['what'],
    span: { start: Date; end: Date } | null,
  ) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    event.stopPropagation();
    const at = momentAt(event.clientX, event.clientY);
    setDrag({
      kind,
      what,
      x: event.clientX,
      y: event.clientY,
      held: span
        ? Math.round((at.getTime() - span.start.getTime()) / 60_000 / STEP) *
          STEP
        : 0,
      length: span
        ? Math.round((span.end.getTime() - span.start.getTime()) / 60_000)
        : 0,
      anchor: kind === 'resize' && span ? span.start : at,
      start: null,
      end: null,
    });
  };
  const moving = drag && drag.start && drag.end ? drag : null;
  /** What is held and has been moved is drawn where it would land, and faint where it was. */
  const isHeld = (what: CalendarEvent | 'draft') =>
    moving !== null &&
    (moving.what === what ||
      (typeof what !== 'string' &&
        typeof moving.what === 'object' &&
        moving.what?.id === what.id));

  return (
    <div
      className={`week${moving ? ` week-dragging week-${moving.kind}` : ''}`}
      role="grid"
      aria-label="Week"
    >
      <div className="week-heads" role="row">
        <span className="week-gutter" />
        {days.map((day) => (
          <div
            key={dayKey(day)}
            role="columnheader"
            className={`week-head${sameDay(day, today) ? ' week-today' : ''}`}
          >
            <span className="week-name">
              {day.toLocaleDateString(undefined, { weekday: 'short' })}
            </span>
            <span className="week-number">{day.getDate()}</span>
          </div>
        ))}
      </div>
      <div className="week-whole" role="row">
        <span className="week-gutter small muted">all day</span>
        {days.map((day) => (
          <div
            key={dayKey(day)}
            role="gridcell"
            className="week-whole-day"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                props.onNew(day, addDays(day, 1), true);
              }
            }}
          >
            {wholeDays
              .filter((each) => within(each, day))
              .map((each) => (
                <button
                  key={each.event.id}
                  type="button"
                  className="whole-event"
                  style={tinted(props.colorOf(each.event))}
                  onClick={() => props.onOpen(each.event)}
                >
                  {titleOf(each.event)}
                </button>
              ))}
            {[...(props.mine ? [props.mine] : []), ...props.away]
              .filter((draft) => draft.form.allDay && within(draft, day))
              .map((draft, index) => (
                <span key={index} className="whole-event whole-draft">
                  {draft.form.title || 'New event'}
                </span>
              ))}
          </div>
        ))}
      </div>
      <div className="week-hours" ref={hours}>
        <div className="week-body" ref={body} style={{ height: 24 * HOUR }}>
          <div className="week-gutter" aria-hidden="true">
            {HOURS.slice(1).map((hour) => (
              <span
                key={hour}
                className="week-hour"
                style={{ top: hour * HOUR }}
              >
                {String(hour).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div
              key={dayKey(day)}
              role="gridcell"
              aria-label={day.toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
              className={`week-day${sameDay(day, today) ? ' week-today' : ''}`}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                  hold(event, 'draw', null, null);
                }
              }}
              onClick={(event) => {
                if (event.target !== event.currentTarget || dragged.current) {
                  return;
                }
                // Where it was pressed, to the half hour before.
                const box = event.currentTarget.getBoundingClientRect();
                const half = Math.floor(((event.clientY - box.top) / HOUR) * 2);
                const from = new Date(day);
                from.setHours(0, Math.max(0, Math.min(47, half)) * 30, 0, 0);
                props.onNew(from);
              }}
            >
              {placeDay(
                events.filter((each) => !each.allDay && within(each, day)),
              ).map((each) => {
                const { top, height } = block(day, each.start, each.end);
                return (
                  <button
                    key={each.event.id}
                    type="button"
                    className={`week-event${height < 34 ? ' week-event-short' : ''}${isHeld(each.event) ? ' week-event-held' : ''}`}
                    style={{
                      ...tinted(props.colorOf(each.event)),
                      top,
                      height: height - 2,
                      left: `calc(${(each.column / each.columns) * 100}% + 2px)`,
                      width: `calc(${100 / each.columns}% - 6px)`,
                    }}
                    onPointerDown={(event) =>
                      hold(event, 'move', each.event, each)
                    }
                    onClick={() => {
                      if (!dragged.current) props.onOpen(each.event);
                    }}
                  >
                    <span className="week-event-title">
                      {titleOf(each.event)}
                    </span>
                    <span className="week-event-time">
                      {timeOf(each.start)} – {timeOf(each.end)}
                    </span>
                    {/* Its lower edge, to pull it longer or shorter by. */}
                    <span
                      className="week-event-edge"
                      aria-hidden="true"
                      onPointerDown={(event) =>
                        hold(event, 'resize', each.event, each)
                      }
                    />
                  </button>
                );
              })}
              {props.mine && !props.mine.form.allDay && within(props.mine, day)
                ? (() => {
                    const draft = props.mine;
                    const { top, height } = block(day, draft.start, draft.end);
                    return (
                      <span
                        className={`week-event week-draft week-mine${isHeld('draft') ? ' week-event-held' : ''}`}
                        style={{ top, height: height - 2, left: 2, right: 4 }}
                        onPointerDown={(event) =>
                          hold(event, 'move', 'draft', draft)
                        }
                      >
                        <span className="week-event-title">
                          {draft.form.title || 'New event'}
                        </span>
                        <span className="week-event-time">
                          {timeOf(draft.start)} – {timeOf(draft.end)}
                        </span>
                        <span
                          className="week-event-edge"
                          aria-hidden="true"
                          onPointerDown={(event) =>
                            hold(event, 'resize', 'draft', draft)
                          }
                        />
                      </span>
                    );
                  })()
                : null}
              {props.away
                .filter((draft) => !draft.form.allDay && within(draft, day))
                .map((draft, index) => {
                  const { top, height } = block(day, draft.start, draft.end);
                  return (
                    <span
                      key={index}
                      className="week-event week-draft"
                      style={{ top, height: height - 2, left: 2, right: 4 }}
                    >
                      <span className="week-event-title">
                        {draft.form.title || 'New event'}
                      </span>
                      <span className="week-event-time">
                        {timeOf(draft.start)} – {timeOf(draft.end)}
                      </span>
                    </span>
                  );
                })}
              {moving && within({ start: moving.start!, end: moving.end! }, day)
                ? (() => {
                    const { top, height } = block(
                      day,
                      moving.start!,
                      moving.end!,
                    );
                    return (
                      <span
                        className="week-event week-draft week-landing"
                        style={{ top, height: height - 2, left: 2, right: 4 }}
                      >
                        <span className="week-event-title">
                          {moving.what === 'draft'
                            ? props.mine?.form.title || 'New event'
                            : moving.what
                              ? titleOf(moving.what)
                              : 'New event'}
                        </span>
                        <span className="week-event-time">
                          {timeOf(moving.start!)} – {timeOf(moving.end!)}
                        </span>
                      </span>
                    );
                  })()
                : null}
              {sameDay(day, now) ? (
                <span
                  className="week-now"
                  style={{
                    top: (now.getHours() + now.getMinutes() / 60) * HOUR,
                  }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function dayName(day: Date, today: Date): string {
  if (sameDay(day, today)) return 'Today';
  if (sameDay(day, addDays(today, 1))) return 'Tomorrow';
  return day.toLocaleDateString(undefined, { weekday: 'long' });
}

function Agenda(props: {
  from: Date;
  today: Date;
  events: readonly Shown[];
  colorOf(event: CalendarEvent): string;
  onOpen(event: CalendarEvent): void;
}) {
  const { from, today, events } = props;
  const days = useMemo(() => {
    const found: Array<{ day: Date; events: Shown[] }> = [];
    for (let index = 0; index < AGENDA_DAYS; index++) {
      const day = addDays(from, index);
      const next = addDays(day, 1);
      const on = events.filter(
        (each) =>
          each.end.getTime() > day.getTime() &&
          each.start.getTime() < next.getTime(),
      );
      // Today is there even with nothing on, so that there is somewhere to stand.
      if (on.length > 0 || sameDay(day, today)) found.push({ day, events: on });
    }
    return found;
  }, [from, today, events]);

  if (days.length === 0) {
    return (
      <p className="muted pad">
        Nothing in the next {AGENDA_DAYS} days from here.
      </p>
    );
  }
  return (
    <div className="agenda">
      {days.map(({ day, events: on }) => (
        <section key={dayKey(day)} aria-label={dayName(day, today)}>
          <h2
            className={`agenda-day${sameDay(day, today) ? ' agenda-today' : ''}`}
          >
            <span>{dayName(day, today)}</span>
            <span className="muted small">
              {day.toLocaleDateString(undefined, {
                weekday: sameDay(day, today) ? 'long' : undefined,
                day: 'numeric',
                month: 'long',
              })}
            </span>
          </h2>
          {on.length === 0 ? (
            <p className="muted agenda-none">Nothing on.</p>
          ) : (
            <ul className="agenda-events">
              {on.map((each) => (
                <li key={each.event.id}>
                  <button
                    type="button"
                    className="agenda-event"
                    style={tinted(props.colorOf(each.event))}
                    onClick={() => props.onOpen(each.event)}
                  >
                    <span className="agenda-time">
                      {each.allDay ? (
                        <strong>all day</strong>
                      ) : (
                        <>
                          <strong>
                            {sameDay(each.start, day)
                              ? timeOf(each.start)
                              : '…'}
                          </strong>
                          <span className="muted small">
                            {sameDay(each.end, day) ? timeOf(each.end) : '…'}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="agenda-bar" aria-hidden="true" />
                    <span className="agenda-what">
                      <strong>{titleOf(each.event)}</strong>
                      <span className="muted small">
                        {Object.values(each.event.locations ?? {})[0]?.name ??
                          ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * An event being written in a window of its own: the same form, with the
 * whole window to itself. What it holds is kept for the window, so that
 * reloading it loses nothing, and told to the calendar it was opened from.
 */
export function EventWindow() {
  const { client } = useServices();
  const calendar = useMemo(() => new Calendars(client), [client]);
  useSynced(calendar.calendars);
  const key = new URLSearchParams(useLocation().search).get('window') ?? '';
  const [form, setForm] = useState<EventForm | null>(() =>
    readDraft(window.sessionStorage, key),
  );
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const said = useRef<BroadcastChannel | null>(null);
  const tell = (message: WindowMessage) => said.current?.postMessage(message);

  useEffect(() => {
    said.current = channel();
    return () => said.current?.close();
  }, []);
  useEffect(() => {
    let current = true;
    calendar.start().then(
      () => current && setState('ready'),
      () => current && setState('failed'),
    );
    return () => {
      current = false;
    };
  }, [calendar]);
  // Each change is kept for this window, and shown where the calendar is open.
  useEffect(() => {
    if (!form) return;
    try {
      window.sessionStorage.setItem(draftKey(key), JSON.stringify(form));
    } catch {
      // Not kept over a reload, then.
    }
    tell({ kind: 'writing', key, form });
    document.title = `${form.title || 'New event'} · mailless`;
  }, [form, key]);
  // Closed by its corner, it is no longer being written.
  useEffect(() => {
    const leaving = () => tell({ kind: 'closed', key });
    window.addEventListener('pagehide', leaving);
    return () => window.removeEventListener('pagehide', leaving);
  }, [key]);

  const done = (kind: 'kept' | 'closed') => {
    try {
      window.sessionStorage.removeItem(draftKey(key));
    } catch {
      // Nothing was kept.
    }
    tell({ kind, key });
    window.close();
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      done('kept');
    } catch (error) {
      setFailure(
        error instanceof Error && error.message
          ? error.message
          : 'That did not work. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!form) {
    return (
      <main className="centered">
        <div className="card card-narrow">
          <p>There is no event being written in this window.</p>
          <Button onClick={() => window.close()}>Close the window</Button>
        </div>
      </main>
    );
  }
  if (state !== 'ready') {
    return (
      <main className="centered">
        <p
          role={state === 'failed' ? 'alert' : 'status'}
          className={state === 'failed' ? 'notice notice-error' : 'muted'}
        >
          {state === 'failed'
            ? 'The calendar could not be loaded. Reload the window to try again.'
            : 'Loading…'}
        </p>
      </main>
    );
  }
  return (
    <main className="event-window">
      <EventEditor
        form={form}
        calendars={calendar.all()}
        busy={busy}
        failure={failure}
        own={calendar.own}
        onChange={setForm}
        onSave={(tell) => void run(() => calendar.save(form, tell))}
        onClose={() => done('closed')}
        {...(form.id !== null
          ? {
              onDelete: (tell: boolean) =>
                void run(() =>
                  calendar.remove(
                    {
                      id: form.id ?? '',
                      ...(form.series ? { baseEventId: form.series.id } : {}),
                    },
                    form.series?.all ?? false,
                    tell,
                  ),
                ),
            }
          : {})}
      />
    </main>
  );
}
