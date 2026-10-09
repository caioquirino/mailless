import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import type { Identity } from '@mailless/jmap-core';
import {
  Button,
  Notice,
  useTheme,
  type Theme,
  type ThemeChoice,
} from '@mailless/ui';
import { isPicture } from '../lib/compose';
import { cardPhoto } from '../lib/contacts';
import { usePreference } from '../lib/preference';
import { UNDO_SECONDS } from '../lib/undo';
import { Face } from './face';
import { FolderSetting } from './folders';
import { TagSetting } from './tags';
import { BlockedSetting } from './senders';
import { CalendarSetting } from './calendars-setting';
import { useMail, useServices, useSynced } from './services';

/** Turning notifications on and off, for wherever there is a switch for it. */
export function useNotificationSwitch() {
  const { notifications, act, say } = useMail();
  const state = useSyncExternalStore(
    notifications.subscribe,
    () => notifications.state,
  );
  const [switching, setSwitching] = useState(false);
  const toggle = () => {
    setSwitching(true);
    const turningOn = state !== 'on';
    void act(() =>
      turningOn ? notifications.enable() : notifications.disable(),
    ).then((done) => {
      setSwitching(false);
      if (done) {
        say(
          turningOn
            ? 'Notifications are on for this browser'
            : 'Notifications are off for this browser',
        );
      }
    });
  };
  return { state, switching, toggle };
}

const THEMES: Array<{ choice: ThemeChoice; name: string; about: string }> = [
  {
    choice: 'system',
    name: 'Same as the system',
    about: 'Light or dark as this device is, changing when it does.',
  },
  { choice: 'light', name: 'Light', about: 'Always light.' },
  { choice: 'dark', name: 'Dark', about: 'Always dark.' },
];

function Appearance({ theme }: { theme: Theme }) {
  const { choice } = useTheme(theme);
  return (
    <section className="setting" aria-labelledby="setting-appearance">
      <h2 id="setting-appearance">Appearance</h2>
      <fieldset className="choices">
        <legend className="visually-hidden">Theme</legend>
        {THEMES.map((each) => (
          <label key={each.choice} className="choice">
            <input
              type="radio"
              name="theme"
              checked={choice === each.choice}
              onChange={() => theme.choose(each.choice)}
            />
            <span>
              <span className="choice-name">{each.name}</span>
              <span className="muted small">{each.about}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

/** The picture that stands for the user, where their own mail is shown. */
function PictureSetting() {
  const { client } = useServices();
  const { store, act, say } = useMail();
  useSynced(store.identities);
  useSynced(store.contacts.cards);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const identity = store.identities.values()[0];
  const [ready, setReady] = useState(store.contacts.cards.isComplete);
  useEffect(() => {
    let current = true;
    void store.contacts.start().then(
      () => current && setReady(true),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [store]);
  // Kept on a card of one's own in the address book, which needs one to be there.
  if (!identity || !ready || !store.contacts.available) return null;
  const me = { name: identity.name || null, email: identity.email };
  const card = store.contacts.cardFor(identity.email);
  const has = card !== undefined && cardPhoto(card) !== null;

  const choose = async (picked: File | undefined) => {
    setProblem(null);
    if (!picked) return;
    if (!isPicture(picked)) {
      setProblem('A picture is a PNG, JPEG, GIF or WebP file.');
      return;
    }
    setBusy(true);
    try {
      const uploaded = await client.upload(picked, { type: picked.type });
      const kept = await act(() =>
        store.contacts.setPhoto(me, uploaded.blobId),
      );
      if (kept) say('Your picture was changed');
    } catch {
      setProblem('The picture could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="setting" aria-labelledby="setting-picture">
      <h2 id="setting-picture">Your picture</h2>
      <p className="muted">
        Shown here for your own mail. It is kept on a card for you in your
        contacts, and goes to nobody: people you write to do not see it.
      </p>
      {problem ? (
        <p className="notice notice-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="row">
        <Face
          name={identity.name || identity.email}
          email={identity.email}
          size="large"
        />
        <label className={`button${busy ? ' disabled' : ''}`}>
          {busy
            ? 'Uploading…'
            : has
              ? 'Change the picture'
              : 'Choose a picture'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="visually-hidden"
            aria-label="Choose your picture"
            disabled={busy}
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = '';
              void choose(picked);
            }}
          />
        </label>
        {has ? (
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={() =>
              void act(() => store.contacts.setPhoto(me, null)).then(
                (gone) => gone && say('Your picture was removed'),
              )
            }
          >
            Remove it
          </button>
        ) : null}
      </div>
    </section>
  );
}

const UNDO_CHOICES = [0, 5, 10, 20, 30];

/** For how long a message just sent can be taken back. */
function UndoSetting() {
  const { store } = useMail();
  const [seconds, setSeconds] = usePreference<number>(UNDO_SECONDS, 10);
  // Where the server cannot hold a message, there is nothing to choose.
  if (store.holdLimit === 0) return null;
  return (
    <section className="setting" aria-labelledby="setting-undo">
      <h2 id="setting-undo">Undo send</h2>
      <p className="muted">
        A message waits this long before it goes, and can be taken back until
        then. It waits on the server, so it is sent even if this page is closed.
      </p>
      <label className="field">
        <span>Wait</span>
        <select
          value={seconds}
          onChange={(event) => setSeconds(Number(event.target.value))}
        >
          {UNDO_CHOICES.map((each) => (
            <option key={each} value={each}>
              {each === 0 ? 'Do not wait' : `${each} seconds`}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

function NotificationSetting() {
  const { state, switching, toggle } = useNotificationSwitch();
  return (
    <section className="setting" aria-labelledby="setting-notifications">
      <h2 id="setting-notifications">Notifications</h2>
      <p className="muted">
        Be told when mail arrives, also when this page is closed. With the page
        closed, a notification says only that there is new mail.
      </p>
      {state === 'unsupported' ? (
        <Notice>
          This browser cannot show notifications for this site. On an iPhone or
          iPad, add the page to the home screen first.
        </Notice>
      ) : state === 'blocked' ? (
        <Notice tone="warning">
          Notifications are blocked for this site. Allow them in the browser’s
          settings for it, then come back here.
        </Notice>
      ) : (
        <div className="row">
          <span>
            {state === 'on' ? 'On for this browser.' : 'Off for this browser.'}
          </span>
          <Button
            variant={state === 'on' ? undefined : 'primary'}
            disabled={switching}
            onClick={toggle}
          >
            {switching
              ? 'One moment…'
              : state === 'on'
                ? 'Turn notifications off'
                : 'Turn notifications on'}
          </Button>
        </div>
      )}
    </section>
  );
}

/** The name someone writes under and how they sign, for one of their addresses. */
function IdentitySetting({ identity }: { identity: Identity }) {
  const { store, act, say } = useMail();
  const [name, setName] = useState(identity.name);
  const [signature, setSignature] = useState(identity.textSignature ?? '');
  const [busy, setBusy] = useState(false);
  const changed =
    name.trim() !== identity.name ||
    signature.trimEnd() !== (identity.textSignature ?? '');

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    const saved = await act(() =>
      store.updateIdentity(identity.id, {
        name: name.trim(),
        textSignature: signature.trimEnd(),
      }),
    );
    setBusy(false);
    if (saved) say('Saved');
  };

  return (
    <form
      className="identity"
      aria-label={identity.email}
      onSubmit={(event) => void save(event)}
    >
      <h3>{identity.email}</h3>
      <label className="stacked">
        <span>Name</span>
        <input
          value={name}
          maxLength={255}
          autoComplete="name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="stacked">
        <span>Signature</span>
        <textarea
          rows={4}
          maxLength={20000}
          value={signature}
          onChange={(event) => setSignature(event.target.value)}
        />
      </label>
      <p className="muted small">
        Put at the end of what you write from this address, and above what you
        quote in an answer. You can change or remove it in each message.
      </p>
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy || !changed}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

/** What someone can set about their mail here. */
export function SettingsPage() {
  const { config, theme } = useServices();
  const { store } = useMail();
  useSynced(store.identities);
  const identities = store.identities.values();
  return (
    <main className="panes">
      <div className="settings" role="region" aria-label="Settings">
        <h1>Settings</h1>
        <p className="muted">
          How mail looks and whether it notifies are kept in this browser, so
          each of your devices can differ.
        </p>
        {theme ? <Appearance theme={theme} /> : null}
        <NotificationSetting />
        <UndoSetting />
        <PictureSetting />
        <FolderSetting />
        <TagSetting />
        <CalendarSetting />
        <BlockedSetting />
        <section className="setting" aria-labelledby="setting-account">
          <h2 id="setting-account">Account</h2>
          {config.accountUrl ? (
            <p>
              <a href={config.accountUrl}>
                Password, passkeys and passwords for mail apps
              </a>
            </p>
          ) : null}
        </section>
        <section className="setting" aria-labelledby="setting-writing">
          <h2 id="setting-writing">Writing</h2>
          <p className="muted">
            Your name and signature for each address you write from. These are
            kept with your mail, so they are the same on every device.
          </p>
          {identities.length > 0 ? (
            identities.map((identity) => (
              // Changed on another device: the form starts again from what is kept.
              <IdentitySetting
                key={`${identity.id} ${identity.name} ${identity.textSignature}`}
                identity={identity}
              />
            ))
          ) : (
            <p className="muted">This account cannot send mail.</p>
          )}
        </section>
      </div>
    </main>
  );
}
