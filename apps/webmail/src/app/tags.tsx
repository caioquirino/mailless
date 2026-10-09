import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import type { Email } from '@mailless/jmap-core';
import { Button, Icon, IconButton } from '@mailless/ui';
import { IMPORTANT, STARRED, TAG_COLORS, type Tag } from '../lib/tags';
import { useMail, useSynced } from './services';

/** The colour of a tag, for whatever is drawn in it. */
const tinted = (tag: Pick<Tag, 'color'>) =>
  ({ '--tag': tag.color }) as CSSProperties;

/** A tag as it is shown on mail: its colour as a dot, and its name. */
export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?(): void }) {
  return (
    <span className="tag-chip" style={tinted(tag)}>
      <span className="tag-dot" aria-hidden="true" />
      {tag.name}
      {onRemove ? (
        <button
          type="button"
          className="tag-chip-remove"
          aria-label={`Remove the tag ${tag.name}`}
          onClick={onRemove}
        >
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </span>
  );
}

/** The tags of some mail, as chips: the first few, and how many more. */
export function TagChips({
  emails,
  most = 3,
}: {
  emails: readonly Email[];
  most?: number;
}) {
  const { store } = useMail();
  useSynced(store.tags.made);
  const tags = store.tags.on(emails);
  if (tags.length === 0) return null;
  return (
    <span className="tag-chips">
      {tags.slice(0, most).map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {tags.length > most ? (
        <span className="muted small">+{tags.length - most}</span>
      ) : null}
    </span>
  );
}

/**
 * Which tags a conversation has: each ticked or not, found by typing, and
 * made on the spot when what was typed is the name of none.
 */
export function TagPicker(props: {
  emails: readonly Email[];
  onClose(): void;
}) {
  const { emails, onClose } = props;
  const { store, act } = useMail();
  useSynced(store.tags.made);
  useSynced(store.emails);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  // Pressed anywhere else, or Escape: it closes.
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const ids = emails.map((email) => email.id);
  const has = (tag: Tag) =>
    emails.some((email) => email.keywords[tag.keyword] === true);
  const wanted = typed.trim();
  const shown = store.tags
    .all()
    .filter((tag) => tag.name.toLowerCase().includes(wanted.toLowerCase()));
  const put = async (tag: Tag, on: boolean) => {
    setBusy(true);
    // A star is put on the last message, as pressing the star does; a tag on all of them.
    await act(() =>
      store.setKeyword(
        on && tag.fixed === 'starred' ? ids.slice(-1) : ids,
        tag.keyword,
        on,
      ),
    );
    setBusy(false);
  };
  const make = async (event: FormEvent) => {
    event.preventDefault();
    if (wanted === '' || busy) return;
    const there = store.tags.named(wanted);
    if (there) return void put(there, !has(there));
    if (!store.tags.available) return;
    setBusy(true);
    await act(async () => {
      // The next colour along, so that new tags do not all look the same.
      const color =
        TAG_COLORS[store.tags.made.values().length % TAG_COLORS.length]
          ?.color ?? IMPORTANT.color;
      const tag = await store.tags.make(wanted, color);
      await store.setKeyword(ids, tag.keyword, true);
      setTyped('');
    });
    setBusy(false);
  };

  return (
    <div
      ref={box}
      className="tag-picker"
      role="dialog"
      aria-label="Tags of this conversation"
    >
      <div className="tag-picker-head">
        <h2>Tags</h2>
        <Button size="small" variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
      <form className="tag-find" onSubmit={(event) => void make(event)}>
        <Icon name="search" size={16} />
        <input
          ref={field}
          aria-label="Find or make a tag"
          placeholder="Find or make a tag"
          maxLength={60}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </form>
      <ul className="tag-choices">
        {shown.map((tag) => (
          <li key={tag.id}>
            <label className="tag-choice" style={tinted(tag)}>
              <input
                type="checkbox"
                checked={has(tag)}
                disabled={busy}
                onChange={(event) => void put(tag, event.target.checked)}
              />
              {tag.fixed === 'starred' ? (
                <span className="tag-star">
                  <Icon name="flag" size={16} />
                </span>
              ) : (
                <span className="tag-dot" aria-hidden="true" />
              )}
              <span>{tag.name}</span>
            </label>
          </li>
        ))}
      </ul>
      {wanted !== '' && !store.tags.named(wanted) && store.tags.available ? (
        <button
          type="button"
          className="tag-make"
          disabled={busy}
          onClick={(event) => void make(event)}
        >
          <Icon name="plus" size={16} />
          Make the tag “{wanted}”
        </button>
      ) : null}
    </div>
  );
}

/** What is being done to the tags, in the settings. */
type Doing = null | { kind: 'new' } | { kind: 'change' | 'remove'; id: string };

/** The tags, in the settings: making one, giving one another name or colour, removing one. */
export function TagSetting() {
  const { store, act, say } = useMail();
  useSynced(store.tags.made);
  const [doing, setDoing] = useState<Doing>(null);
  const [busy, setBusy] = useState(false);
  if (!store.tags.available) return null;
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    const worked = await act(action);
    setBusy(false);
    if (!worked) return;
    setDoing(null);
    say(done);
  };
  return (
    <section className="setting" aria-labelledby="setting-tags">
      <div className="folders-head">
        <div>
          <h2 id="setting-tags">Tags</h2>
          <p className="muted">
            A conversation is in one folder, and can have as many tags as you
            like. Deleting a tag takes it off the mail; the mail stays where it
            is.
          </p>
        </div>
        <Button
          variant="primary"
          icon="plus"
          disabled={busy}
          onClick={() => setDoing({ kind: 'new' })}
        >
          New tag
        </Button>
      </div>
      {doing?.kind === 'new' ? (
        <TagForm
          label="Name of the new tag"
          start={{
            name: '',
            color:
              TAG_COLORS[store.tags.made.values().length % TAG_COLORS.length]
                ?.color ?? IMPORTANT.color,
          }}
          busy={busy}
          button="Add"
          onCancel={() => setDoing(null)}
          onSave={(name, color) =>
            void run(() => store.tags.make(name, color), `${name} was made`)
          }
        />
      ) : null}
      <ul className="folders" aria-label="Your tags">
        {store.tags.all().map((tag) => (
          <li key={tag.id}>
            {doing?.kind === 'change' && doing.id === tag.id ? (
              <TagForm
                label={`Name of ${tag.name}`}
                start={tag}
                busy={busy}
                button="Save"
                onCancel={() => setDoing(null)}
                onSave={(name, color) =>
                  void run(
                    () => store.tags.change(tag.id, { name, color }),
                    `${name} was changed`,
                  )
                }
              />
            ) : (
              <div className="folder" style={tinted(tag)}>
                {tag.fixed === 'starred' ? (
                  <span className="tag-star">
                    <Icon name="flag" size={18} />
                  </span>
                ) : (
                  <span className="tag-dot tag-dot-large" aria-hidden="true" />
                )}
                <span className="folder-name">
                  <strong>{tag.name}</strong>
                </span>
                {tag.fixed ? (
                  <span className="muted small tag-fixed">Always there</span>
                ) : (
                  <>
                    <IconButton
                      icon="write"
                      label={`Rename or recolour ${tag.name}`}
                      disabled={busy}
                      onClick={() => setDoing({ kind: 'change', id: tag.id })}
                    />
                    <IconButton
                      icon="delete"
                      label={`Delete the tag ${tag.name}`}
                      disabled={busy}
                      onClick={() => setDoing({ kind: 'remove', id: tag.id })}
                    />
                  </>
                )}
              </div>
            )}
            {doing?.kind === 'remove' && doing.id === tag.id ? (
              <div
                className="notice notice-warning confirm"
                role="alertdialog"
                aria-label={`Delete the tag ${tag.name}`}
              >
                <p>
                  Delete the tag “{tag.name}”? It is taken off every
                  conversation that has it. No mail is deleted.
                </p>
                <div className="row">
                  <Button
                    size="small"
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => store.tags.remove(tag.id),
                        `${tag.name} was deleted`,
                      )
                    }
                  >
                    Delete the tag
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

/** A tag's name and its colour. */
export function TagForm(props: {
  label: string;
  start: { name: string; color: string };
  busy: boolean;
  button: string;
  /** The colours to choose from, when not those of tags. */
  colors?: ReadonlyArray<{ color: string; name: string }>;
  onSave(name: string, color: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(props.start.name);
  const [color, setColor] = useState(props.start.color);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '' || props.busy) return;
    props.onSave(wanted, color);
  };
  return (
    <form className="folder-form" onSubmit={submit}>
      <input
        ref={field}
        aria-label={props.label}
        placeholder="Name"
        maxLength={60}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <span className="tag-colors" role="radiogroup" aria-label="Colour">
        {(props.colors ?? TAG_COLORS).map((each) => (
          <button
            key={each.color}
            type="button"
            role="radio"
            className="tag-color"
            style={tinted(each)}
            aria-checked={color === each.color}
            aria-label={each.name}
            title={each.name}
            onClick={() => setColor(each.color)}
          />
        ))}
      </span>
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

export { STARRED };
