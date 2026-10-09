import { useEffect, useState, type FormEvent } from 'react';
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

/** The senders whose pictures are always shown, in the settings: seen, added to, taken off. */
export function PicturesSetting() {
  const { store, act, say } = useMail();
  useSynced(store.pictures.made);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  if (!store.pictures.available) return null;
  const all = store.pictures.all();
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
      () => store.pictures.always(wanted),
      `Pictures from ${wanted} will always be shown`,
    ).then((worked) => {
      if (worked) setAddress('');
    });
  };
  return (
    <section className="setting" aria-labelledby="setting-pictures">
      <h2 id="setting-pictures">Pictures</h2>
      <p className="muted">
        Pictures kept on other sites are not shown until you ask: loading them
        tells the sender you opened the message. From these they are always
        shown, unless nothing confirms the message really comes from them.
      </p>
      <form className="folder-form" onSubmit={submit}>
        <input
          aria-label="Address or domain to always show pictures from"
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
          Always show
        </Button>
      </form>
      {all.length === 0 ? (
        <p className="muted small">You are asked every time.</p>
      ) : (
        <ul className="folders" aria-label="Pictures always shown from">
          {all.map((each) => (
            <li key={each.id}>
              <div className="folder">
                <Icon name="picture" size={18} />
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
                  label={`Ask before showing pictures from ${each.address}`}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => store.pictures.ask(each.address),
                      `You will be asked before pictures from ${each.address} are shown`,
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

/**
 * The person's addresses elsewhere, in the settings: mail from them bears
 * the person's name rightly, and is not warned of. Kept on their own card in
 * the address book, where any other program finds them too.
 */
export function OwnAddressesSetting() {
  const { store, act, say } = useMail();
  useSynced(store.identities);
  useSynced(store.contacts.cards);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
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
  const own = store.identities.values();
  if (!ready || !store.contacts.available || own.length === 0) return null;
  const others = store.contacts.otherAddresses(own);
  const keep = async (wanted: string[], done: string) => {
    setBusy(true);
    const worked = await act(() =>
      store.contacts.setOtherAddresses(own, wanted),
    );
    setBusy(false);
    if (worked) say(done);
    return worked;
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = address.trim().toLowerCase();
    if (busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(wanted)) return;
    void keep([...others, wanted], `${wanted} is one of your addresses`).then(
      (worked) => {
        if (worked) setAddress('');
      },
    );
  };
  return (
    <section className="setting" aria-labelledby="setting-own-addresses">
      <h2 id="setting-own-addresses">Your other addresses</h2>
      <p className="muted">
        Addresses of yours at other mail services. Mail from them is from you:
        it is not warned of as bearing your name from somewhere else. They are
        kept on your own card in Contacts.
      </p>
      <form className="folder-form" onSubmit={submit}>
        <input
          type="email"
          aria-label="Another address of yours"
          placeholder="you@elsewhere.example"
          maxLength={320}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || address.trim() === ''}
        >
          Add address
        </Button>
      </form>
      {others.length === 0 ? (
        <p className="muted small">You have told of none.</p>
      ) : (
        <ul className="folders" aria-label="Your other addresses">
          {others.map((each) => (
            <li key={each}>
              <div className="folder">
                <Icon name="account" size={18} />
                <span className="folder-name">
                  <strong>{each}</strong>
                </span>
                <IconButton
                  icon="delete"
                  label={`Remove ${each}`}
                  disabled={busy}
                  onClick={() =>
                    void keep(
                      others.filter((other) => other !== each),
                      `${each} was removed`,
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
