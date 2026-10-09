import { useEffect, useState, type CSSProperties } from 'react';
import { Button, IconButton } from '@mailless/ui';
import { CALENDAR_COLORS, DEFAULT_COLOR, type Calendar } from '../lib/calendar';
import { useMail, useSynced } from './services';
import { TagForm } from './tags';

type Doing =
  | { kind: 'new' }
  | { kind: 'change'; id: string }
  | { kind: 'remove'; id: string }
  | null;

const tinted = (calendar: Pick<Calendar, 'color'>) =>
  ({ '--tag': calendar.color ?? DEFAULT_COLOR }) as CSSProperties;

/** The calendars, in the settings: made, named, coloured and removed. */
export function CalendarSetting() {
  const { store, act, say } = useMail();
  const calendar = store.calendar;
  useSynced(calendar.calendars);
  const [ready, setReady] = useState(calendar.calendars.isComplete);
  const [doing, setDoing] = useState<Doing>(null);
  const [busy, setBusy] = useState(false);
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
            go in the default one unless you choose another.
          </p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          disabled={busy}
          onClick={() => setDoing({ kind: 'new' })}
        >
          New calendar
        </Button>
      </div>
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
                </span>
                {each.isDefault ? (
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
