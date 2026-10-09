import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Avatar, Icon, IconButton } from '@mailless/ui';
import { nameOf } from '../lib/addresses';
import type { Person } from '../lib/people';
import {
  formatSearch,
  isEmptySearch,
  mergeSearch,
  narrowings,
  NO_SEARCH,
  parseSearch,
  tagsOf,
  SEARCH_WORDS,
  WITHIN_NAMES,
  withoutNarrowing,
  type Search,
  type Within,
} from '../lib/search';
import { useMail, useSynced } from './services';

/** `from:ma` or `to:` at the end of what is typed: someone being named. */
const NAMING = /(?:^|\s)(from|to):([^\s"]*)$/i;

/**
 * Where mail is searched for. A search is typed, with words such as `from:`
 * that narrow it, or filled in as a form: the two are one search, and
 * changing either changes the other. What narrows it is shown in the bar,
 * each to be taken out by itself.
 */
export function SearchBar() {
  const { store } = useMail();
  useSynced(store.mailboxes);
  useSynced(store.tags.made);
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const uid = useId();
  const searching = location.pathname.startsWith('/search');
  const asked = searching ? (params.get('q') ?? '') : '';

  /** What narrows the search, and the words being typed, which may end in one not finished. */
  const [narrowed, setNarrowed] = useState<Search>(NO_SEARCH);
  const [typing, setTyping] = useState('');
  const [open, setOpen] = useState<'nothing' | 'help' | 'form'>('nothing');
  const [marked, setMarked] = useState(0);
  const [, setPeopleKnown] = useState(false);
  const box = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);

  // The bar says what is being looked at: the search in the address, or none.
  useEffect(() => {
    const search = parseSearch(asked);
    setNarrowed({ ...search, words: '' });
    setTyping(search.words);
  }, [asked]);

  useEffect(() => {
    if (open === 'nothing') return undefined;
    const outside = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen('nothing');
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  /** The search as it stands: what narrows it, and everything typed read as part of it. */
  const whole = (): Search => {
    const read = parseSearch(typing);
    return { ...mergeSearch(narrowed, read), words: read.words };
  };
  const go = (search: Search) => {
    setOpen('nothing');
    if (isEmptySearch(search)) return;
    void navigate(`/search?q=${encodeURIComponent(formatSearch(search))}`);
  };
  const change = (text: string) => {
    setMarked(0);
    // A space ends a word: what it said about the search leaves the words.
    if (/\s$/.test(text)) {
      const read = parseSearch(text);
      if (narrowings(read).length > 0) {
        setNarrowed(mergeSearch(narrowed, read));
        setTyping(read.words === '' ? '' : `${read.words} `);
        return;
      }
    }
    setTyping(text);
  };
  const clear = () => {
    setNarrowed(NO_SEARCH);
    setTyping('');
    setOpen('nothing');
    if (searching) void navigate('/');
    else field.current?.focus();
  };
  /** Changes what narrows the search. One that is being looked at is looked at afresh. */
  const narrow = (next: Search) => {
    setNarrowed(next);
    if (searching && open !== 'form') {
      const search = { ...next, words: parseSearch(typing).words };
      if (isEmptySearch(search)) void navigate('/');
      else go(search);
    }
  };

  const naming = NAMING.exec(typing);
  const people =
    open === 'help' && naming && (naming[2] ?? '') !== ''
      ? store.people.find(naming[2] as string, {
          // Whoever wrote the mail that has been looked at here, too.
          others: store.emails.values().flatMap((email) => email.from ?? []),
        })
      : [];
  const at = Math.min(marked, people.length - 1);
  const name = (person: Person) => {
    if (!naming) return;
    const key = (naming[1] as string).toLowerCase() as 'from' | 'to';
    setNarrowed({ ...narrowed, [key]: person.email });
    setTyping(typing.slice(0, naming.index).trimEnd());
    setMarked(0);
    field.current?.focus();
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    const person = people[at];
    if (person && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setMarked((at + step + people.length) % people.length);
    } else if (person && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      name(person);
    } else if (event.key === 'Escape' && open !== 'nothing') {
      setOpen('nothing');
    } else if (event.key === 'Backspace' && typing === '') {
      const last = narrowings(narrowed).at(-1);
      if (last) narrow(withoutNarrowing(narrowed, last));
    }
  };
  /** Who a narrowing names, by their name when they are known. */
  const shown = (value: string) =>
    store.people
      .find(value, {
        others: store.emails.values().flatMap((email) => email.from ?? []),
      })
      .find((each) => each.email === value)?.name ?? value;
  const any = typing !== '' || narrowings(narrowed).length > 0;
  const set = (changes: Partial<Search>) =>
    setNarrowed({ ...narrowed, ...changes });
  const words = parseSearch(typing).words;

  return (
    <form
      ref={box}
      className="search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        go(whole());
      }}
    >
      <Icon name="search" size={18} />
      <ul className="search-narrowed" aria-label="What narrows the search">
        {narrowings(narrowed).map((each, index) => (
          <li
            key={`${each.key}-${each.value}-${index}`}
            className="search-token"
          >
            <span>
              <strong>{each.name}</strong>
              {each.key === 'from' || each.key === 'to'
                ? shown(each.value)
                : each.key === 'within'
                  ? WITHIN_NAMES[each.value as Within].toLowerCase()
                  : each.value}
            </span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${each.name}${each.value}`}
              onClick={() => narrow(withoutNarrowing(narrowed, each))}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        <li className="search-typing">
          <input
            ref={field}
            type="search"
            aria-label="Search mail"
            placeholder={narrowings(narrowed).length > 0 ? '' : 'Search mail'}
            autoComplete="off"
            spellCheck={false}
            value={typing}
            onChange={(event) => change(event.target.value)}
            onKeyDown={key}
            onFocus={() => {
              if (open === 'nothing') setOpen('help');
              // Who there is to name is found out when first asked for.
              void store.people
                .start(store.mailbox('sent')?.id)
                .then(() => setPeopleKnown(true));
            }}
          />
        </li>
      </ul>
      {any ? (
        <IconButton
          className="search-button"
          icon="close"
          label="Clear the search"
          onClick={clear}
        />
      ) : null}
      <IconButton
        className="search-button"
        icon="options"
        label={open === 'form' ? 'Hide search options' : 'Show search options'}
        pressed={open === 'form'}
        onClick={() => setOpen(open === 'form' ? 'nothing' : 'form')}
      />
      {open === 'help' ? (
        <div className="search-panel">
          {people.length > 0 ? (
            <ul
              className="search-people"
              role="listbox"
              aria-label="People by that name"
            >
              {people.map((person, index) => (
                <li
                  key={person.email}
                  role="option"
                  aria-selected={index === at}
                  className="suggestion"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => name(person)}
                >
                  <Avatar name={nameOf(person)} size="small" />
                  <span className="suggestion-who">
                    <span className="suggestion-name">{nameOf(person)}</span>
                    {person.name ? (
                      <span className="muted small">{person.email}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <h2 className="search-heading">You can type</h2>
          <ul className="search-words">
            {SEARCH_WORDS.map((each) => (
              <li key={each.typed}>
                <button
                  type="button"
                  className="search-word"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    change(
                      `${typing.trimEnd()}${typing.trim() ? ' ' : ''}${each.typed}${
                        each.typed.endsWith(':') ? '' : ' '
                      }`,
                    );
                    field.current?.focus();
                  }}
                >
                  <code>{each.typed}</code>
                  <span className="muted small">{each.means}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="search-foot">
            <button
              type="button"
              className="button button-small button-quiet button-with-icon"
              onClick={() => setOpen('form')}
            >
              <Icon name="options" size={16} />
              Show search options
            </button>
            <span className="muted small">
              <kbd>Enter</kbd> to search
            </span>
          </div>
        </div>
      ) : null}
      {open === 'form' ? (
        <div
          className="search-panel search-form"
          role="group"
          aria-label="Search options"
        >
          <p className="search-note muted small">
            Typing in the search fills this in, and filling this in writes the
            search.
          </p>
          <label className="field">
            <span>From</span>
            <input
              value={narrowed.from}
              onChange={(event) => set({ from: event.target.value })}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              value={narrowed.to}
              onChange={(event) => set({ to: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Subject</span>
            <input
              value={narrowed.subject}
              onChange={(event) => set({ subject: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Has the words</span>
            <input
              value={words}
              onChange={(event) => setTyping(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Does not have</span>
            <input
              value={narrowed.without}
              onChange={(event) => set({ without: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Received</span>
            <select
              value={narrowed.within}
              onChange={(event) =>
                set({ within: event.target.value as Within })
              }
            >
              {(Object.keys(WITHIN_NAMES) as Within[]).map((each) => (
                <option key={each} value={each}>
                  {WITHIN_NAMES[each]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>In</span>
            <select
              value={
                store.mailboxes
                  .values()
                  .find(
                    (each) =>
                      each.name.toLowerCase() === narrowed.in.toLowerCase() ||
                      each.role === narrowed.in.toLowerCase(),
                  )?.name ?? ''
              }
              onChange={(event) => set({ in: event.target.value })}
            >
              <option value="">All mail</option>
              {/* A folder is searched with the folders inside it. */}
              {store.mailboxes.values().map((each) => (
                <option key={each.id} value={each.name}>
                  {each.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field search-tagged">
            <span id={`${uid}-tagged`}>Tagged</span>
            <div
              className="search-tags"
              role="group"
              aria-labelledby={`${uid}-tagged`}
            >
              {store.tags
                .all()
                .filter((tag) => tag.fixed !== 'starred')
                .map((tag) => {
                  const chosen = tagsOf(narrowed).some(
                    (name) => name.toLowerCase() === tag.name.toLowerCase(),
                  );
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className="search-tag"
                      aria-pressed={chosen}
                      style={{ '--tag': tag.color } as CSSProperties}
                      onClick={() =>
                        set({
                          tags: (chosen
                            ? tagsOf(narrowed).filter(
                                (name) =>
                                  name.toLowerCase() !== tag.name.toLowerCase(),
                              )
                            : [...tagsOf(narrowed), tag.name]
                          ).join('\n'),
                        })
                      }
                    >
                      <span className="tag-dot" aria-hidden="true" />
                      {tag.name}
                    </button>
                  );
                })}
            </div>
          </div>
          <div className="search-checks">
            <label htmlFor={`${uid}-starred`}>
              <input
                id={`${uid}-starred`}
                type="checkbox"
                checked={narrowed.starred}
                onChange={(event) => set({ starred: event.target.checked })}
              />
              Starred
            </label>
            <label htmlFor={`${uid}-attachment`}>
              <input
                id={`${uid}-attachment`}
                type="checkbox"
                checked={narrowed.hasAttachment}
                onChange={(event) =>
                  set({ hasAttachment: event.target.checked })
                }
              />
              Has an attachment
            </label>
            <label htmlFor={`${uid}-unread`}>
              <input
                id={`${uid}-unread`}
                type="checkbox"
                checked={narrowed.unread}
                onChange={(event) => set({ unread: event.target.checked })}
              />
              Not read yet
            </label>
          </div>
          <div className="search-foot">
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setNarrowed(NO_SEARCH);
                setTyping('');
              }}
            >
              Clear all
            </button>
            <button type="submit" className="button button-primary button-pill">
              Search
            </button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
