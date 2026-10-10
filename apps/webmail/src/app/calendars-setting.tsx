import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, IconButton } from '@mailless/ui';
import {
  CALENDAR_COLORS,
  DEFAULT_COLOR,
  keptElsewhere,
  type Calendar,
} from '../lib/calendar';
import { useMail, useSynced } from './services';
import { TagForm } from './tags';

type Doing =
  | { kind: 'new' }
  | { kind: 'subscribe' }
  | { kind: 'change'; id: string }
  | { kind: 'remove'; id: string }
  | null;

const tinted = (calendar: Pick<Calendar, 'color'>) =>
  ({ '--tag': calendar.color ?? DEFAULT_COLOR }) as CSSProperties;

/** What a chosen file says. */
const textOf = (file: File): Promise<string> =>
  typeof file.text === 'function'
    ? file.text()
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('The file could not be read.'));
        reader.readAsText(file);
      });

/** How the last look at a calendar kept somewhere else went, in a few words. */
function subscriptionLine(
  subscription:
    | { fetchedAt: string | null; problem: string | null; events: number }
    | undefined,
): string {
  if (!subscription) return 'kept somewhere else';
  if (subscription.problem) {
    return `kept somewhere else · could not be fetched: ${subscription.problem}`;
  }
  const minutes = subscription.fetchedAt
    ? Math.max(
        0,
        Math.round((Date.now() - Date.parse(subscription.fetchedAt)) / 60_000),
      )
    : null;
  const when =
    minutes === null
      ? 'not looked at yet'
      : minutes < 1
        ? 'looked at just now'
        : minutes < 90
          ? `looked at ${minutes} min ago`
          : `looked at ${Math.round(minutes / 60)} h ago`;
  return `kept somewhere else · ${subscription.events} events · ${when}`;
}

function SubscribeForm(props: {
  busy: boolean;
  color: string;
  onCancel(): void;
  onSave(name: string, color: string, url: string): void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const ready =
    name.trim() !== '' && /^(https|webcals?):\/\/\S+$/i.test(url.trim());
  return (
    <form
      className="folder-form subscribe-form"
      aria-label="Subscribe to a calendar"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !props.busy) props.onSave(name.trim(), props.color, url);
      }}
    >
      <p className="muted small">
        A calendar kept somewhere else shows here and is changed there. Paste
        the address it is published at: in Google Calendar, the calendar’s
        settings, “Secret address in iCal format”. Whoever has that address can
        read the calendar, so keep it to yourself.
      </p>
      <input
        aria-label="Name of the calendar"
        placeholder="Name, as it will show here"
        maxLength={80}
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      <input
        aria-label="Address of the calendar"
        placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
        type="url"
        maxLength={2000}
        autoComplete="off"
        spellCheck={false}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <Button type="submit" variant="primary" disabled={props.busy || !ready}>
        {props.busy ? 'Fetching…' : 'Subscribe'}
      </Button>
      <Button onClick={props.onCancel}>Cancel</Button>
    </form>
  );
}

/** The calendars, in the settings: made, named, coloured and removed. */
export function CalendarSetting() {
  const { store, act, say } = useMail();
  const calendar = store.calendar;
  useSynced(calendar.calendars);
  useSynced(calendar);
  const [ready, setReady] = useState(calendar.calendars.isComplete);
  const [doing, setDoing] = useState<Doing>(null);
  const [busy, setBusy] = useState(false);
  /** The calendar a file is being chosen for. */
  const into = useRef<Calendar | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let current = true;
    void calendar.start().then(
      () => current && setReady(true),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [calendar]);
  if (!ready || !calendar.available) return null;
  const all = calendar.all();
  const several = (count: number, one: string, many: string) =>
    count === 1 ? `1 ${one}` : `${count} ${many}`;
  const takeIn = async (file: File | undefined) => {
    const target = into.current;
    if (!file || !target) return;
    setBusy(true);
    let told = '';
    const worked = await act(async () => {
      const { added, already, refused } = await calendar.importCalendar(
        target.id,
        await textOf(file),
      );
      told = [
        `${several(added, 'event', 'events')} added to ${target.name}`,
        already > 0 ? `${already} already there` : '',
        refused > 0 ? `${refused} could not be read` : '',
      ]
        .filter(Boolean)
        .join(', ');
    });
    setBusy(false);
    if (worked) say(told);
  };
  const giveOut = async (each: Calendar) => {
    setBusy(true);
    await act(async () => {
      const file = new Blob([await calendar.exportCalendar(each.id)], {
        type: 'text/calendar',
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = `${each.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'calendar'}.ics`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
    setBusy(false);
  };
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    const worked = await act(action);
    setBusy(false);
    if (!worked) return;
    setDoing(null);
    say(done);
  };
  return (
    <section className="setting" aria-labelledby="setting-calendars">
      <div className="folders-head">
        <div>
          <h2 id="setting-calendars">Calendars</h2>
          <p className="muted">
            An event is in one calendar, which gives it its colour. New events
            go in the default one unless you choose another. A calendar can be
            taken out as an .ics file, and one from another program put in.
          </p>
        </div>
        <span className="row">
          {calendar.subscribable ? (
            <Button
              disabled={busy}
              onClick={() => setDoing({ kind: 'subscribe' })}
            >
              Subscribe to a calendar
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon="plus"
            disabled={busy}
            onClick={() => setDoing({ kind: 'new' })}
          >
            New calendar
          </Button>
        </span>
      </div>
      {doing?.kind === 'subscribe' ? (
        <SubscribeForm
          busy={busy}
          color={
            CALENDAR_COLORS[all.length % CALENDAR_COLORS.length]?.color ??
            DEFAULT_COLOR
          }
          onCancel={() => setDoing(null)}
          onSave={(name, color, url) =>
            void run(
              () => calendar.addFrom(name, color, url),
              `${name} was added. It is looked at again every half hour while the calendar is open.`,
            )
          }
        />
      ) : null}
      {doing?.kind === 'new' ? (
        <TagForm
          label="Name of the new calendar"
          colors={CALENDAR_COLORS}
          start={{
            name: '',
            color:
              CALENDAR_COLORS[all.length % CALENDAR_COLORS.length]?.color ??
              DEFAULT_COLOR,
          }}
          busy={busy}
          button="Add"
          onCancel={() => setDoing(null)}
          onSave={(name, color) =>
            void run(
              () => calendar.makeCalendar(name, color),
              `${name} was made`,
            )
          }
        />
      ) : null}
      <input
        ref={chooser}
        type="file"
        accept=".ics,text/calendar"
        className="visually-hidden"
        aria-label="Calendar file to import"
        tabIndex={-1}
        onChange={(event) => {
          const [file] = event.target.files ?? [];
          // The same file may be chosen again.
          event.target.value = '';
          void takeIn(file);
        }}
      />
      <ul className="folders" aria-label="Your calendars">
        {all.map((each) => (
          <li key={each.id}>
            {doing?.kind === 'change' && doing.id === each.id ? (
              <TagForm
                label={`Name of ${each.name}`}
                colors={CALENDAR_COLORS}
                start={{ name: each.name, color: each.color ?? DEFAULT_COLOR }}
                busy={busy}
                button="Save"
                onCancel={() => setDoing(null)}
                onSave={(name, color) =>
                  void run(
                    () => calendar.changeCalendar(each.id, { name, color }),
                    `${name} was changed`,
                  )
                }
              />
            ) : (
              <div className="folder" style={tinted(each)}>
                <span className="tag-dot tag-dot-large" aria-hidden="true" />
                <span className="folder-name">
                  <strong>{each.name}</strong>
                  {keptElsewhere(each) ? (
                    <span className="muted small">
                      {' '}
                      {subscriptionLine(calendar.subscriptions.get(each.id))}
                    </span>
                  ) : null}
                </span>
                {keptElsewhere(each) ? (
                  <Button
                    size="small"
                    variant="quiet"
                    disabled={busy}
                    aria-label={`Look at ${each.name} again`}
                    onClick={() =>
                      void run(
                        () => calendar.refreshSubscriptions([each.id]),
                        `${each.name} was looked at again`,
                      )
                    }
                  >
                    Refresh
                  </Button>
                ) : each.isDefault ? (
                  <span className="muted small tag-fixed">Default</span>
                ) : (
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => calendar.setDefault(each.id),
                        `New events go in ${each.name}`,
                      )
                    }
                  >
                    Make default
                  </Button>
                )}
                {keptElsewhere(each) ? null : (
                  <Button
                    size="small"
                    variant="quiet"
                    disabled={busy}
                    aria-label={`Import a file into ${each.name}`}
                    onClick={() => {
                      into.current = each;
                      chooser.current?.click();
                    }}
                  >
                    Import
                  </Button>
                )}
                <Button
                  size="small"
                  variant="quiet"
                  disabled={busy}
                  aria-label={`Export ${each.name} as a file`}
                  onClick={() => void giveOut(each)}
                >
                  Export
                </Button>
                <IconButton
                  icon="write"
                  label={`Rename or recolour ${each.name}`}
                  disabled={busy}
                  onClick={() => setDoing({ kind: 'change', id: each.id })}
                />
                {all.length > 1 ? (
                  <IconButton
                    icon="delete"
                    label={`Delete the calendar ${each.name}`}
                    disabled={busy}
                    onClick={() => setDoing({ kind: 'remove', id: each.id })}
                  />
                ) : null}
              </div>
            )}
            {doing?.kind === 'remove' && doing.id === each.id ? (
              <div
                className="notice notice-warning confirm"
                role="alertdialog"
                aria-label={`Delete the calendar ${each.name}`}
              >
                <p>
                  Delete the calendar “{each.name}” and every event in it? This
                  cannot be undone.
                </p>
                <div className="row">
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => calendar.removeCalendar(each.id),
                        `${each.name} was deleted`,
                      )
                    }
                  >
                    Delete the calendar and its events
                  </Button>
                  <Button size="small" onClick={() => setDoing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
