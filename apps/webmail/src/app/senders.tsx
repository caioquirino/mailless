import { useState, type FormEvent } from 'react';
import { Button, Icon, IconButton } from '@mailless/ui';
import { useMail, useSynced } from './services';

/** The senders whose mail goes to the junk, in the settings: seen, added to, taken off. */
export function BlockedSetting() {
  const { store, act, say } = useMail();
  useSynced(store.blocked.made);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  if (!store.blocked.available) return null;
  const blocked = store.blocked.all();
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    const worked = await act(action);
    setBusy(false);
    if (worked) say(done);
    return worked;
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = address.trim().toLowerCase();
    if (wanted === '' || busy) return;
    void run(
      () => store.blocked.block(wanted),
      `More from ${wanted} will go to Junk`,
    ).then((worked) => {
      if (worked) setAddress('');
    });
  };
  return (
    <section className="setting" aria-labelledby="setting-blocked">
      <h2 id="setting-blocked">Blocked senders</h2>
      <p className="muted">
        What these send goes straight to Junk, where you can still find it. They
        are not told. Reporting a message as junk blocks who sent it, unless
        they are in your contacts.
      </p>
      <form className="folder-form" onSubmit={submit}>
        <input
          aria-label="Address or domain to block"
          placeholder="someone@example.com, or @example.com for everyone there"
          maxLength={320}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || address.trim() === ''}
        >
          Block
        </Button>
      </form>
      {blocked.length === 0 ? (
        <p className="muted small">Nobody is blocked.</p>
      ) : (
        <ul className="folders" aria-label="Blocked senders">
          {blocked.map((each) => (
            <li key={each.id}>
              <div className="folder">
                <Icon name="junk" size={18} />
                <span className="folder-name">
                  <strong>{each.address}</strong>
                  {each.address.startsWith('@') ? (
                    <span className="muted small">
                      {' '}
                      everyone at this domain
                    </span>
                  ) : null}
                </span>
                <IconButton
                  icon="delete"
                  label={`Stop blocking ${each.address}`}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => store.blocked.unblock(each.address),
                      `${each.address} is no longer blocked`,
                    )
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
