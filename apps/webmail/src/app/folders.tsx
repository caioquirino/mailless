import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Mailbox } from '@mailless/jmap-core';
import { Button, Icon, IconButton } from '@mailless/ui';
import { orderMailboxes } from '../lib/mailboxes';
import { useMail, useSynced } from './services';

/** What is being done to the folders: nothing, making one, or changing or removing one. */
type Doing =
  | null
  | { kind: 'new'; inside: string }
  | { kind: 'change'; id: string }
  | { kind: 'remove'; id: string };

/**
 * The folders someone made for themselves: making one, at the top or inside
 * another, giving one another name or place, and removing one. The menu
 * shows them; this is the only place they are changed.
 */
export function FolderSetting() {
  const { store, act, say } = useMail();
  useSynced(store.mailboxes);
  const [doing, setDoing] = useState<Doing>(null);
  const [busy, setBusy] = useState(false);
  const folders = orderMailboxes(store.mailboxes.values()).filter(
    (entry, index, all) => {
      // Its own, and inside nothing that every account comes with.
      let top = index;
      while ((all[top]?.depth ?? 0) > 0) top--;
      return all[top]?.mailbox.role === null && entry.mailbox.role === null;
    },
  );
  /** The folders one may be put inside: not itself, and nothing inside it. */
  const places = (moving?: string) => {
    let within: number | null = null;
    return folders.filter(({ mailbox, depth }) => {
      if (within !== null && depth > within) return false;
      within = null;
      if (mailbox.id !== moving) return true;
      within = depth;
      return false;
    });
  };
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    const worked = await act(action);
    setBusy(false);
    if (!worked) return;
    setDoing(null);
    say(done);
  };

  const form = (
    label: string,
    start: { name: string; inside: string },
    moving: string | undefined,
    save: (name: string, inside: string | null) => Promise<unknown>,
    done: (name: string) => string,
    button: string,
  ) => (
    <FolderForm
      label={label}
      start={start}
      places={places(moving)}
      busy={busy}
      button={button}
      onCancel={() => setDoing(null)}
      onSave={(name, inside) => void run(() => save(name, inside), done(name))}
    />
  );

  return (
    <section className="setting" aria-labelledby="setting-folders">
      <div className="folders-head">
        <div>
          <h2 id="setting-folders">Folders</h2>
          <p className="muted">
            Inbox, Drafts, Sent, Archive, Junk and Trash are always there. These
            are the ones you made.
          </p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          disabled={busy}
          onClick={() => setDoing({ kind: 'new', inside: '' })}
        >
          New folder
        </Button>
      </div>
      {doing?.kind === 'new' && doing.inside === ''
        ? form(
            'Name of the new folder',
            { name: '', inside: '' },
            undefined,
            (name, inside) => store.createMailbox(name, inside),
            (name) => `${name} was made`,
            'Add',
          )
        : null}
      {folders.length === 0 ? (
        <p className="muted">You have made no folders yet.</p>
      ) : (
        <ul className="folders" aria-label="Your folders">
          {folders.map(({ mailbox, depth }) => (
            <li key={mailbox.id}>
              {doing?.kind === 'change' && doing.id === mailbox.id ? (
                form(
                  `Name of ${mailbox.name}`,
                  { name: mailbox.name, inside: mailbox.parentId ?? '' },
                  mailbox.id,
                  (name, inside) =>
                    store.changeMailbox(mailbox.id, { name, parentId: inside }),
                  (name) => `${name} was changed`,
                  'Save',
                )
              ) : (
                <div className={`folder depth-${Math.min(depth, 4)}`}>
                  <Icon name="folder" size={18} />
                  <span className="folder-name">
                    <strong>{mailbox.name}</strong>{' '}
                    <span className="muted small">
                      {mailbox.totalEmails === 1
                        ? '1 message'
                        : `${mailbox.totalEmails} messages`}
                    </span>
                  </span>
                  <Button
                    size="small"
                    variant="quiet"
                    icon="plus"
                    disabled={busy}
                    aria-label={`New folder inside ${mailbox.name}`}
                    onClick={() =>
                      setDoing({ kind: 'new', inside: mailbox.id })
                    }
                  >
                    Subfolder
                  </Button>
                  <IconButton
                    icon="write"
                    label={`Rename or move ${mailbox.name}`}
                    disabled={busy}
                    onClick={() => setDoing({ kind: 'change', id: mailbox.id })}
                  />
                  <IconButton
                    icon="delete"
                    label={`Delete ${mailbox.name}`}
                    disabled={busy}
                    onClick={() => setDoing({ kind: 'remove', id: mailbox.id })}
                  />
                </div>
              )}
              {doing?.kind === 'remove' && doing.id === mailbox.id ? (
                <div
                  className="notice notice-warning confirm"
                  role="alertdialog"
                  aria-label={`Delete ${mailbox.name}`}
                >
                  <p>
                    Delete the folder “{mailbox.name}”?{' '}
                    {mailbox.totalEmails === 0
                      ? 'It is empty.'
                      : mailbox.totalEmails === 1
                        ? 'The 1 message in it goes to the Trash.'
                        : `The ${mailbox.totalEmails} messages in it go to the Trash.`}
                  </p>
                  <div className="row">
                    <Button
                      size="small"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => store.removeMailbox(mailbox.id),
                          `${mailbox.name} was deleted`,
                        )
                      }
                    >
                      Delete it
                    </Button>
                    <Button size="small" onClick={() => setDoing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              {doing?.kind === 'new' && doing.inside === mailbox.id
                ? form(
                    `Name of the new folder inside ${mailbox.name}`,
                    { name: '', inside: mailbox.id },
                    undefined,
                    (name, inside) => store.createMailbox(name, inside),
                    (name) => `${name} was made`,
                    'Add',
                  )
                : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A folder's name, and which folder it is inside. */
function FolderForm(props: {
  label: string;
  start: { name: string; inside: string };
  places: ReadonlyArray<{ mailbox: Mailbox; depth: number }>;
  busy: boolean;
  button: string;
  onSave(name: string, inside: string | null): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(props.start.name);
  const [inside, setInside] = useState(props.start.inside);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '' || props.busy) return;
    props.onSave(wanted, inside === '' ? null : inside);
  };
  return (
    <form className="folder-form" onSubmit={submit}>
      <input
        ref={field}
        aria-label={props.label}
        placeholder="Name"
        maxLength={100}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="folder-inside">
        <span className="muted small">Inside</span>
        <select
          value={inside}
          onChange={(event) => setInside(event.target.value)}
        >
          <option value="">Nothing: at the top</option>
          {props.places.map(({ mailbox, depth }) => (
            <option key={mailbox.id} value={mailbox.id}>
              {`${' '.repeat(depth)}${mailbox.name}`}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <Button
          type="submit"
          size="small"
          variant="primary"
          disabled={props.busy || name.trim() === ''}
        >
          {props.button}
        </Button>
        <Button size="small" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
