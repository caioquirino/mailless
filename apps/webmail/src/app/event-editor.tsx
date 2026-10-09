import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Icon, IconButton, type IconName } from '@mailless/ui';
import {
  DEFAULT_COLOR,
  REMINDER_CHOICES,
  REPEATS,
  formProblem,
  reminderText,
  remindersOf,
  usedParts,
  type Calendar,
  type EventForm,
  type FormPart,
} from '../lib/calendar';

/*
 * Writing an event. One form that starts small (what, when, in which
 * calendar) and grows where it stands: a place, people, a link, reminders
 * and notes are each added to it when wanted, and those used last time are
 * there to begin with. There is no second, fuller form to go to.
 */

const PARTS: ReadonlyArray<{ part: FormPart; label: string; icon: IconName }> =
  [
    { part: 'repeat', label: 'Repeat', icon: 'refresh' },
    { part: 'place', label: 'Place', icon: 'place' },
    { part: 'people', label: 'People', icon: 'contacts' },
    { part: 'link', label: 'Video link', icon: 'link' },
    { part: 'reminders', label: 'Reminders', icon: 'bell' },
    { part: 'notes', label: 'Notes', icon: 'note' },
  ];

const PARTS_KEY = 'mailless.calendar.parts';

/** The parts opened the last time an event was written, in this browser. */
function rememberedParts(): FormPart[] {
  try {
    const kept: unknown = JSON.parse(
      window.localStorage.getItem(PARTS_KEY) ?? '[]',
    );
    return Array.isArray(kept)
      ? PARTS.map((each) => each.part).filter((part) => kept.includes(part))
      : [];
  } catch {
    return [];
  }
}

function rememberParts(parts: readonly FormPart[]): void {
  try {
    window.localStorage.setItem(PARTS_KEY, JSON.stringify(parts));
  } catch {
    // Not remembered, then.
  }
}

export interface EventEditorProps {
  form: EventForm;
  calendars: readonly Calendar[];
  busy: boolean;
  /** What went wrong keeping it, when something did. */
  failure?: string | null;
  onChange(form: EventForm): void;
  onSave(): void;
  onClose(): void;
  /** Removes the event. Not there for one that is not kept yet. */
  onDelete?(): void;
  /** Moves the form to a window of its own. Not there where it already is in one. */
  onPopOut?(): void;
}

export function EventEditor(props: EventEditorProps) {
  const { form, calendars, busy } = props;
  const [open, setOpen] = useState<FormPart[]>(() => [
    ...new Set([
      ...usedParts(form),
      // A new event starts with what was used for the last one.
      ...(form.id === null ? rememberedParts() : []),
    ]),
  ]);
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => title.current?.focus(), []);
  const set = (change: Partial<EventForm>) =>
    props.onChange({ ...form, ...change });
  const calendar = calendars.find((each) => each.id === form.calendarId);
  const own = remindersOf(calendar?.defaultAlertsWithTime);
  const problem = formProblem(form);

  const add = (part: FormPart) => {
    setOpen([...open, part]);
    if (part === 'repeat' && form.repeat === 'none') set({ repeat: 'weekly' });
    // Reminders start as the calendar's own, to be changed from there.
    if (part === 'reminders' && form.reminders === null) {
      set({ reminders: own.length > 0 ? own : [30] });
    }
  };
  const drop = (part: FormPart) => {
    setOpen(open.filter((each) => each !== part));
    set(
      part === 'repeat'
        ? { repeat: 'none', until: '' }
        : part === 'place'
          ? { place: '' }
          : part === 'people'
            ? { people: '' }
            : part === 'link'
              ? { link: '' }
              : part === 'notes'
                ? { notes: '' }
                : { reminders: null },
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || problem) return;
    rememberParts(open);
    props.onSave();
  };
  const field = (
    part: FormPart,
    label: string,
    icon: IconName,
    control: React.ReactNode,
  ) =>
    open.includes(part) ? (
      <div className="event-part">
        <span className="event-part-icon">
          <Icon name={icon} size={18} />
        </span>
        <div className="event-part-body">{control}</div>
        <IconButton
          icon="close"
          label={`Remove: ${label}`}
          onClick={() => drop(part)}
        />
      </div>
    ) : null;

  return (
    <form
      className="event-editor"
      aria-label={form.id === null ? 'New event' : 'Event'}
      onSubmit={submit}
    >
      <header className="event-head">
        <h2>{form.id === null ? 'New event' : 'Event'}</h2>
        {props.onPopOut ? (
          <IconButton
            icon="expand"
            label="Open in a window of its own"
            onClick={props.onPopOut}
          />
        ) : null}
        <IconButton icon="close" label="Close" onClick={props.onClose} />
      </header>
      <div className="event-fields">
        <input
          ref={title}
          className="event-title"
          aria-label="Title"
          placeholder="Add a title"
          maxLength={200}
          value={form.title}
          onChange={(event) => set({ title: event.target.value })}
        />
        <div className="event-when">
          <input
            type="date"
            aria-label="Day"
            required
            value={form.date}
            onChange={(event) =>
              set({
                date: event.target.value,
                // The end follows, as far behind the start as it was.
                endDate:
                  form.endDate === form.date ||
                  form.endDate < event.target.value
                    ? event.target.value
                    : form.endDate,
              })
            }
          />
          {form.allDay ? (
            <>
              <span className="muted">to</span>
              <input
                type="date"
                aria-label="Last day"
                min={form.date}
                value={form.endDate < form.date ? form.date : form.endDate}
                onChange={(event) => set({ endDate: event.target.value })}
              />
            </>
          ) : (
            <>
              <input
                type="time"
                aria-label="Starts"
                required
                value={form.from}
                onChange={(event) => set({ from: event.target.value })}
              />
              <span className="muted">–</span>
              <input
                type="time"
                aria-label="Ends"
                required
                value={form.to}
                onChange={(event) => set({ to: event.target.value })}
              />
            </>
          )}
          <label className="event-all-day">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(event) => set({ allDay: event.target.checked })}
            />
            All day
          </label>
        </div>
        {calendars.length > 1 ? (
          <div className="event-part">
            <span
              className="event-dot"
              style={{ background: calendar?.color ?? DEFAULT_COLOR }}
              aria-hidden="true"
            />
            <div className="event-part-body">
              <select
                aria-label="Calendar"
                value={form.calendarId}
                onChange={(event) => set({ calendarId: event.target.value })}
              >
                {calendars.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {form.series ? (
          <fieldset className="event-scope">
            <legend>This event repeats. Change:</legend>
            <label>
              <input
                type="radio"
                name="event-scope"
                checked={!form.series.all}
                onChange={() =>
                  set({ series: { ...form.series!, all: false } })
                }
              />
              This one
            </label>
            <label>
              <input
                type="radio"
                name="event-scope"
                checked={form.series.all}
                onChange={() => set({ series: { ...form.series!, all: true } })}
              />
              Every one
            </label>
          </fieldset>
        ) : null}
        {/* How it repeats is said of all of it, not of one of its times. */}
        {form.series && !form.series.all
          ? null
          : field(
              'repeat',
              'Repeat',
              'refresh',
              <div className="event-repeat">
                <select
                  aria-label="Repeats"
                  value={form.repeat}
                  onChange={(event) =>
                    set({ repeat: event.target.value as EventForm['repeat'] })
                  }
                >
                  {REPEATS.map((each) => (
                    <option key={each.repeat} value={each.repeat}>
                      {each.label}
                    </option>
                  ))}
                  {form.repeat === 'custom' ? (
                    <option value="custom">In a way of its own</option>
                  ) : null}
                </select>
                {form.repeat !== 'none' && form.repeat !== 'custom' ? (
                  <label className="event-until">
                    <span className="muted small">Until</span>
                    <input
                      type="date"
                      aria-label="Last day it repeats"
                      min={form.date}
                      value={form.until}
                      onChange={(event) => set({ until: event.target.value })}
                    />
                  </label>
                ) : null}
              </div>,
            )}
        {field(
          'place',
          'Place',
          'place',
          <input
            aria-label="Place"
            placeholder="Where"
            maxLength={200}
            value={form.place}
            onChange={(event) => set({ place: event.target.value })}
          />,
        )}
        {field(
          'people',
          'People',
          'contacts',
          <input
            aria-label="People"
            placeholder="Addresses, with commas between them"
            value={form.people}
            onChange={(event) => set({ people: event.target.value })}
          />,
        )}
        {field(
          'link',
          'Video link',
          'link',
          <input
            aria-label="Video link"
            type="url"
            placeholder="https://"
            value={form.link}
            onChange={(event) => set({ link: event.target.value })}
          />,
        )}
        {field(
          'reminders',
          'Reminders',
          'bell',
          <div className="event-reminders">
            {(form.reminders ?? []).map((minutes, index) => (
              <span key={index} className="event-reminder">
                <select
                  aria-label={`Reminder ${index + 1}`}
                  value={minutes}
                  onChange={(event) =>
                    set({
                      reminders: (form.reminders ?? []).map((each, at) =>
                        at === index ? Number(event.target.value) : each,
                      ),
                    })
                  }
                >
                  {[...new Set([...REMINDER_CHOICES, minutes])]
                    .sort((a, b) => a - b)
                    .map((choice) => (
                      <option key={choice} value={choice}>
                        {reminderText(choice)}
                      </option>
                    ))}
                </select>
                <IconButton
                  icon="close"
                  label={`Remove reminder ${index + 1}`}
                  onClick={() =>
                    set({
                      reminders: (form.reminders ?? []).filter(
                        (_, at) => at !== index,
                      ),
                    })
                  }
                />
              </span>
            ))}
            {(form.reminders ?? []).length < 5 ? (
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  set({
                    reminders: [
                      ...(form.reminders ?? []),
                      REMINDER_CHOICES.find(
                        (choice) => !(form.reminders ?? []).includes(choice),
                      ) ?? 60,
                    ],
                  })
                }
              >
                Add a reminder
              </button>
            ) : null}
            {(form.reminders ?? []).length === 0 ? (
              <span className="muted small">No reminder for this event.</span>
            ) : null}
          </div>,
        )}
        {field(
          'notes',
          'Notes',
          'note',
          <textarea
            aria-label="Notes"
            placeholder="Notes"
            rows={3}
            value={form.notes}
            onChange={(event) => set({ notes: event.target.value })}
          />,
        )}
        {PARTS.some((each) => !open.includes(each.part)) ? (
          <div className="event-add" role="group" aria-label="Add to the event">
            {PARTS.filter(
              (each) =>
                !open.includes(each.part) &&
                !(each.part === 'repeat' && form.series && !form.series.all),
            ).map((each) => (
              <button
                key={each.part}
                type="button"
                className="event-add-part"
                onClick={() => add(each.part)}
              >
                <Icon name={each.icon} size={16} />
                {each.label}
              </button>
            ))}
          </div>
        ) : null}
        {form.reminders === null && !open.includes('reminders') ? (
          <p className="muted small event-own">
            {own.length > 0
              ? `Reminder: ${own.map(reminderText).join(', ').toLowerCase()}, as for everything in ${calendar?.name ?? 'this calendar'}.`
              : 'No reminder, as for everything in this calendar.'}
          </p>
        ) : null}
        {props.failure ? (
          <p className="notice notice-error" role="alert">
            {props.failure}
          </p>
        ) : null}
      </div>
      <footer className="event-foot">
        {props.onDelete ? (
          <Button
            type="button"
            icon="delete"
            disabled={busy}
            onClick={props.onDelete}
          >
            Delete
          </Button>
        ) : null}
        <span className="event-foot-gap">
          {problem && form.title !== '' ? (
            <span className="muted small">{problem}</span>
          ) : null}
        </span>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || problem !== null}
        >
          Save
        </Button>
      </footer>
    </form>
  );
}
