import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Icon, IconButton, type IconName } from '@mailless/ui';
import {
  DEFAULT_COLOR,
  REMINDER_CHOICES,
  REPEATS,
  formProblem,
  formSpan,
  reminderText,
  remindersOf,
  usedParts,
  type Answer,
  type Calendar,
  type EventForm,
  type FormPart,
  type Own,
  withSpan,
} from '../lib/calendar';
import type { Person } from '../lib/people';
import { Recipients, typed } from './recipients';

/** Somewhere an event might be: a place it was before, or where someone in the address book is. */
export interface Place {
  place: string;
  /** Whose it is, for a place that is someone's address. */
  of?: string;
}

/** What someone answered, in a word. */
export const ANSWER_WORDS: Record<string, string> = {
  accepted: 'Yes',
  tentative: 'Maybe',
  declined: 'No',
  'needs-action': 'No answer yet',
};

const ANSWERS: ReadonlyArray<{ answer: Answer; label: string }> = [
  { answer: 'accepted', label: 'Yes' },
  { answer: 'tentative', label: 'Maybe' },
  { answer: 'declined', label: 'No' },
];

/** Another time for an event one was invited to, to send to whoever invited. */
export function ProposeForm(props: {
  start: Date;
  end: Date;
  busy: boolean;
  onSend(start: Date, end: Date, comment: string): void;
  onCancel(): void;
}) {
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = (date: Date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = (date: Date) =>
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const [date, setDate] = useState(day(props.start));
  const [from, setFrom] = useState(time(props.start));
  const [to, setTo] = useState(time(props.end));
  const [comment, setComment] = useState('');
  const at = (clock: string) => new Date(`${date}T${clock}:00`);
  const start = at(from);
  let end = at(to);
  // An end before the start is on the day after.
  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + 86_400_000);
  }
  const valid = !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime());
  return (
    <div className="propose" role="group" aria-label="Suggest another time">
      <div className="event-when">
        <input
          type="date"
          aria-label="Suggested day"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <input
          type="time"
          aria-label="Suggested start"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <span className="muted">–</span>
        <input
          type="time"
          aria-label="Suggested end"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      <input
        aria-label="A word to go with it"
        placeholder="A word to go with it (optional)"
        maxLength={300}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="row">
        <Button
          type="button"
          size="small"
          variant="primary"
          disabled={props.busy || !valid}
          onClick={() => props.onSend(start, end, comment)}
        >
          Send the suggestion
        </Button>
        <Button type="button" size="small" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Yes, maybe, no: the three things to say to an invitation, with the one that was said pressed. */
export function AnswerButtons(props: {
  answer: string;
  busy: boolean;
  onAnswer(answer: Answer): void;
}) {
  return (
    <span className="answer-buttons" role="group" aria-label="Your answer">
      {ANSWERS.map((each) => (
        <button
          key={each.answer}
          type="button"
          className={`button button-small${props.answer === each.answer ? ' answer-given' : ''}`}
          aria-pressed={props.answer === each.answer}
          disabled={props.busy}
          onClick={() => props.onAnswer(each.answer)}
        >
          {each.label}
        </button>
      ))}
    </span>
  );
}

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
  /** Set for an event that is only shown here: why it cannot be changed. */
  locked?: string;
  /** The addresses the person goes by, for who an event with people on it is from. */
  own?: readonly Own[];
  /** Who what is typed among the people might be the start of: the address book, and who was written to. */
  suggest?(typed: string, without: readonly string[]): Person[];
  /** Where it might be, for what is typed as the place to be chosen from. */
  places?: readonly Place[];
  onChange(form: EventForm): void;
  /** Keeps it. `tell` is whether the people on it are to be told, which is asked each time. */
  onSave(tell: boolean): void;
  onClose(): void;
  /** Removes the event. Not there for one that is not kept yet. */
  onDelete?(tell: boolean): void;
  /** Answers the invitation the event is, and tells whoever it is from. */
  onAnswer?(answer: Answer): void;
  /** Suggests another time for it to whoever it is from. Not there where that cannot be done. */
  onPropose?(start: Date, end: Date, comment: string): void;
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
  /** Whether there were others on it when it was opened: they hear of what is done to it even when taken off. */
  const [hadPeople] = useState(form.people.trim() !== '');
  /** What is about to be done, while it is asked whether the others are to be told. */
  const [asking, setAsking] = useState<'save' | 'delete' | null>(null);
  const others =
    form.invited === null && (hadPeople || form.people.trim() !== '');
  const selves = props.own ?? [];
  /** Whether another time is being written out, to suggest to whoever invited. */
  const [proposing, setProposing] = useState(false);
  /** What is being typed after the last of the people, before it is one of them. */
  const [typing, setTyping] = useState('');
  const invitees = (typed(form.people) ?? []).map((person) => ({
    name: form.names[person.email.toLowerCase()] ?? person.name ?? null,
    email: person.email,
  }));
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
    if (busy || problem || typing.trim() !== '') return;
    rememberParts(open);
    // With others on it, whether to tell them is asked every time.
    if (others) setAsking('save');
    else props.onSave(false);
  };
  const tellOrNot = (tell: boolean) => {
    const what = asking;
    setAsking(null);
    if (what === 'save') props.onSave(tell);
    else props.onDelete?.(tell);
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
      {props.locked ? (
        <p className="notice small event-locked" role="note">
          {props.locked}
        </p>
      ) : null}
      <div className="event-fields" inert={props.locked !== undefined}>
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
                onChange={(event) => {
                  const [hour, minute] = event.target.value
                    .split(':')
                    .map(Number);
                  if (hour === undefined || minute === undefined) {
                    return set({ from: event.target.value });
                  }
                  // It stays as long as it was: the end goes with the start.
                  const { start, end } = formSpan(form);
                  const next = new Date(start);
                  next.setHours(hour, minute, 0, 0);
                  props.onChange(
                    withSpan(
                      form,
                      next,
                      new Date(
                        next.getTime() + end.getTime() - start.getTime(),
                      ),
                    ),
                  );
                }}
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
                checked={!form.series.all && !form.series.following}
                onChange={() =>
                  set({
                    series: { ...form.series!, all: false, following: false },
                  })
                }
              />
              This one
            </label>
            <label>
              <input
                type="radio"
                name="event-scope"
                checked={!form.series.all && form.series.following === true}
                onChange={() =>
                  set({
                    series: { ...form.series!, all: false, following: true },
                  })
                }
              />
              This and following
            </label>
            <label>
              <input
                type="radio"
                name="event-scope"
                checked={form.series.all}
                onChange={() =>
                  set({
                    series: { ...form.series!, all: true, following: false },
                  })
                }
              />
              Every one
            </label>
          </fieldset>
        ) : null}
        {/* How it repeats is said of all of it, not of one of its times. */}
        {form.series && !form.series.all && !form.series.following
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
          <>
            <input
              aria-label="Place"
              placeholder="Where"
              maxLength={200}
              list="event-places"
              value={form.place}
              onChange={(event) => set({ place: event.target.value })}
            />
            {/* What the browser offers under the field as it is typed in. */}
            <datalist id="event-places">
              {(props.places ?? []).map((each) => (
                <option
                  key={`${each.place}|${each.of ?? ''}`}
                  value={each.place}
                >
                  {each.of ?? ''}
                </option>
              ))}
            </datalist>
          </>,
        )}
        {form.invited ? (
          <div className="event-invited">
            <p>
              <strong>Invitation</strong> from {form.invited.by}
              {form.people ? (
                <span className="muted small"> · with {form.people}</span>
              ) : null}
            </p>
            {props.onAnswer ? (
              <AnswerButtons
                answer={form.invited.answer}
                busy={busy}
                onAnswer={props.onAnswer}
              />
            ) : null}
            {props.onPropose && !proposing ? (
              <button
                type="button"
                className="button button-small"
                onClick={() => setProposing(true)}
              >
                Suggest another time
              </button>
            ) : null}
            {props.onPropose && proposing ? (
              <ProposeForm
                start={formSpan(form).start}
                end={formSpan(form).end}
                busy={busy}
                onCancel={() => setProposing(false)}
                onSend={(start, end, comment) => {
                  setProposing(false);
                  props.onPropose?.(start, end, comment);
                }}
              />
            ) : null}
          </div>
        ) : (
          field(
            'people',
            'People',
            'contacts',
            <div className="event-people">
              <Recipients
                id="event-people"
                label="People"
                className="event-recipients"
                value={{ list: invitees, typing }}
                suggest={(text) =>
                  props.suggest?.(text, [
                    ...invitees.map((each) => each.email),
                    ...selves.map((each) => each.email),
                  ]) ?? []
                }
                onChange={(value) => {
                  setTyping(value.typing);
                  const list = value.list.map((each) => ({
                    ...each,
                    email: each.email.trim().toLowerCase(),
                  }));
                  set({
                    people: [...new Set(list.map((each) => each.email))].join(
                      ', ',
                    ),
                    // Someone chosen from those known is known by name; someone typed is their address.
                    names: Object.fromEntries(
                      list
                        .map((each) => [
                          each.email,
                          each.name?.trim() || form.names[each.email] || '',
                        ])
                        .filter(([, name]) => name !== ''),
                    ),
                  });
                }}
              />
              {Object.keys(form.answers).length > 0 ? (
                <ul className="event-answers" aria-label="What they answered">
                  {Object.entries(form.answers).map(([email, answer]) => (
                    <li key={email} className={`answer-${answer}`}>
                      {email}
                      <span className="muted small">
                        {' '}
                        · {ANSWER_WORDS[answer] ?? ANSWER_WORDS['needs-action']}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {selves.length > 1 ? (
                <label className="event-as">
                  <span className="muted small">Invite as</span>
                  <select
                    aria-label="Invite as"
                    value={form.as || (selves[0]?.email ?? '')}
                    onChange={(event) => set({ as: event.target.value })}
                  >
                    {selves.map((each) => (
                      <option key={each.email} value={each.email}>
                        {each.name
                          ? `${each.name} <${each.email}>`
                          : each.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>,
          )
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
                !(each.part === 'people' && form.invited) &&
                !(
                  each.part === 'repeat' &&
                  form.series &&
                  !form.series.all &&
                  !form.series.following
                ),
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
      {props.locked ? null : asking ? (
        <footer
          className="event-foot event-ask"
          role="alertdialog"
          aria-label="Tell the others?"
        >
          <span className="event-foot-gap">
            {form.invited
              ? `Tell ${form.invited.by} you are not coming?`
              : asking === 'delete'
                ? 'Tell the people on it that it is cancelled?'
                : 'Send this to the people on it?'}
          </span>
          <Button type="button" onClick={() => setAsking(null)}>
            Back
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => tellOrNot(false)}
          >
            Don’t send
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => tellOrNot(true)}
          >
            Send
          </Button>
        </footer>
      ) : (
        <footer className="event-foot">
          {props.onDelete ? (
            <Button
              type="button"
              icon="delete"
              disabled={busy}
              onClick={() => {
                // With others on it, or as someone invited, whether to say so is asked.
                if (others || form.invited) setAsking('delete');
                else props.onDelete?.(false);
              }}
            >
              Delete
            </Button>
          ) : null}
          <span className="event-foot-gap">
            {typing.trim() !== '' ? (
              <span className="muted small">
                “{typing.trim()}” is not an address yet.
              </span>
            ) : problem && form.title !== '' ? (
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
      )}
    </form>
  );
}
