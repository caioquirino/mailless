import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Identity } from '@mailless/jmap-core';
import {
  Button,
  Notice,
  useTheme,
  type Theme,
  type ThemeChoice,
} from '@mailless/ui';
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
