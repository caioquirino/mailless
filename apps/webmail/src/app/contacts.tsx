import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Link,
  NavLink,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import type { Email } from '@mailless/jmap-core';
import { Avatar, Button, Icon, Tag, type IconName } from '@mailless/ui';
import { emptyDraft, isPicture } from '../lib/compose';
import {
  cardAbout,
  cardBirthday,
  cardEmails,
  cardName,
  cardOf,
  cardPhones,
  cardPhoto,
  formatBirthday,
  formOf,
  formProblem,
  grouped,
  KIND_NAMES,
  searchCards,
  type Card,
  type CardForm,
  type Kind,
} from '../lib/contacts';
import { formatWhen } from '../lib/format';
import { More } from './reader';
import { useMail, useServices, useSynced } from './services';

/** Written to this often, of the messages sent lately, someone is one of those written to often. */
const OFTEN = 2;

export interface ContactsPageProps {
  /** Which person, `new` for one being added, or nobody. */
  cardId: string | undefined;
  editing: boolean;
  /** Whether the list of address books is open, where it is a drawer. */
  menu: boolean;
  onCloseMenu(): void;
}

/** The address book: who is in it, one of them at a time, and the form to change them. */
export function ContactsPage(props: ContactsPageProps) {
  const { cardId, editing, menu, onCloseMenu } = props;
  const { store } = useMail();
  const { contacts, people } = store;
  useSynced(contacts.cards);
  useSynced(contacts.books);
  const location = useLocation();
  const [params] = useSearchParams();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let current = true;
    Promise.all([contacts.start(), people.start(store.mailbox('sent')?.id)])
      // What another device changed since this page was opened.
      .then(() => contacts.refresh())
      .then(
        () => current && setState('ready'),
        () => current && setState('failed'),
      );
    return () => {
      current = false;
    };
  }, [contacts, people, store]);
  // Going somewhere is what the drawer was opened for.
  useEffect(
    () => onCloseMenu(),
    [location.pathname, location.search, onCloseMenu],
  );
  useEffect(() => {
    document.title = 'Contacts · mailless';
  }, []);

  const books = contacts.books.values();
  const within = params.get('book');
  const book = books.find((each) => each.id === within);
  const all = contacts.cards.values();
  const shown = useMemo(() => {
    const inBook =
      within === 'often'
        ? all.filter((card) =>
            cardEmails(card).some(
              (each) => people.timesWritten(each.value) >= OFTEN,
            ),
          )
        : book
          ? all.filter((card) => card.addressBookIds?.[book.id])
          : all;
    return searchCards(inBook, typed);
    // The list of cards is a new one whenever any of them changes.
  }, [all, within, book, typed, people]);
  const title =
    within === 'often' ? 'Written to often' : (book?.name ?? 'All contacts');
  const query = within ? `?book=${encodeURIComponent(within)}` : '';
  const card =
    cardId && cardId !== 'new' ? contacts.cards.get(cardId) : undefined;
  const open = cardId !== undefined;

  const side = (
    <div className={`side${menu ? ' side-open' : ''}`}>
      <Link className="button write" to={`/contacts/new${query}`}>
        <Icon name="plus" />
        <span className="write-label">New contact</span>
      </Link>
      {menu ? (
        <button
          type="button"
          className="side-backdrop"
          aria-label="Close the list of address books"
          onClick={onCloseMenu}
        />
      ) : null}
      <nav className="sidebar" aria-label="Address books">
        <ul className="mailboxes">
          <li>
            <NavLink
              to="/contacts"
              end
              className={`mailbox${within ? '' : ' active'}`}
            >
              <Icon name="contacts" size={18} />
              <span className="mailbox-name">All contacts</span>
              <span className="count">{all.length || ''}</span>
            </NavLink>
          </li>
          <li>
            <Link
              to="/contacts?book=often"
              className={`mailbox${within === 'often' ? ' active' : ''}`}
            >
              <Icon name="send" size={18} />
              <span className="mailbox-name">Written to often</span>
            </Link>
          </li>
        </ul>
        {books.length > 1 ? (
          <>
            <h2 className="side-heading">Address books</h2>
            <ul className="mailboxes">
              {books.map((each) => (
                <li key={each.id}>
                  <Link
                    to={`/contacts?book=${encodeURIComponent(each.id)}`}
                    className={`mailbox${within === each.id ? ' active' : ''}`}
                  >
                    <Icon name="folder" size={18} />
                    <span className="mailbox-name">{each.name}</span>
                    <span className="count">
                      {all.filter((one) => one.addressBookIds?.[each.id])
                        .length || ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </nav>
    </div>
  );

  let detail: ReactNode;
  if (state === 'loading') {
    detail = (
      <p role="status" className="muted pad">
        Loading…
      </p>
    );
  } else if (state === 'failed' || !contacts.available) {
    detail = (
      <p className="notice notice-error pad" role="alert">
        {state === 'failed'
          ? 'Your contacts could not be loaded. Check your connection and try again.'
          : 'This server keeps no address book.'}
      </p>
    );
  } else if (cardId === 'new' || (card && editing)) {
    detail = (
      <CardEditor
        key={cardId}
        card={card}
        back={card ? `/contacts/${card.id}${query}` : `/contacts${query}`}
        query={query}
        bookId={book?.id}
      />
    );
  } else if (card) {
    detail = <CardView key={card.id} card={card} query={query} />;
  } else if (open) {
    detail = (
      <div className="pad">
        <p className="muted">This contact is no longer here.</p>
        <p>
          <Link to={`/contacts${query}`}>Back to the contacts</Link>
        </p>
      </div>
    );
  } else {
    detail = (
      <p className="muted pad">
        {all.length === 0
          ? 'Nobody is in your contacts yet.'
          : 'Choose someone to see how to reach them.'}
      </p>
    );
  }

  return (
    <>
      {side}
      <main className={`contacts-panes${open ? ' contacts-open' : ''}`}>
        <section className="list contacts-list" aria-label={title}>
          <div className="toolbar">
            <div className="contacts-search">
              <Icon name="search" size={18} />
              <input
                type="search"
                aria-label="Search contacts"
                placeholder="Search contacts"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
              {typed !== '' ? (
                <button
                  type="button"
                  className="icon-button contacts-clear"
                  aria-label="Clear the search"
                  title="Clear the search"
                  onClick={() => setTyped('')}
                >
                  <Icon name="close" size={16} />
                </button>
              ) : null}
            </div>
            <span className="muted small" aria-label={`${shown.length} people`}>
              {shown.length}
            </span>
          </div>
          <h1 className="visually-hidden">{title}</h1>
          {within ? (
            // Which of the people these are, and the way back to all of them.
            <p className="contacts-within">
              <span className="chip">
                <span className="chip-name">{title}</span>
                <Link
                  className="chip-remove"
                  to={cardId ? `/contacts/${cardId}` : '/contacts'}
                  aria-label="Show all contacts"
                  title="Show all contacts"
                >
                  <Icon name="close" size={12} />
                </Link>
              </span>
            </p>
          ) : null}
          <div className="contacts-rows">
            {state === 'ready' && shown.length === 0 ? (
              <div className="pad">
                <p className="muted">
                  {typed.trim() ? 'Nobody by that name.' : 'Nobody here yet.'}
                </p>
                {(typed.trim() !== '' || within) && all.length > 0 ? (
                  <p>
                    <Link to="/contacts" onClick={() => setTyped('')}>
                      Show all contacts
                    </Link>
                  </p>
                ) : null}
              </div>
            ) : null}
            {grouped(shown).map((group) => (
              <section key={group.letter} aria-label={group.letter}>
                <h2 className="contacts-letter">{group.letter}</h2>
                <ul>
                  {group.cards.map((each) => (
                    <li key={each.id}>
                      <NavLink
                        to={`/contacts/${each.id}${query}`}
                        className="contact-row"
                      >
                        <RowFace card={each} />
                        <span className="contact-row-text">
                          <span className="contact-row-name">
                            {cardName(each)}
                          </span>
                          <span className="muted small">{cardAbout(each)}</span>
                        </span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>
        <section className="reader contact" aria-label="Contact">
          {detail}
        </section>
      </main>
    </>
  );
}

/** A picture kept with a card, once it has been fetched. */
function usePhoto(blobId: string | null): string | null {
  const { store } = useMail();
  useSynced(store.contacts.photos);
  return blobId ? (store.contacts.photos.url(blobId) ?? null) : null;
}

/** Someone in the list, by their picture when they have one. */
function RowFace({ card }: { card: Card }) {
  const photo = usePhoto(cardPhoto(card));
  return photo ? (
    <img className="avatar avatar-photo" src={photo} alt="" />
  ) : (
    <Avatar name={cardName(card)} />
  );
}

function Face({ name, photo }: { name: string; photo: string | null }) {
  return photo ? (
    <img className="contact-photo" src={photo} alt="" />
  ) : (
    <Avatar name={name} size="large" />
  );
}

function Detail(props: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="contact-detail">
      <span className="contact-detail-icon" title={props.label}>
        <Icon name={props.icon} />
      </span>
      <div className="contact-detail-values">{props.children}</div>
    </div>
  );
}

/** One person: how to reach them, and the mail there has been with them. */
function CardView({ card, query }: { card: Card; query: string }) {
  const { client } = useServices();
  const { store, compose, act, say } = useMail();
  useSynced(store.identities);
  const navigate = useNavigate();
  const identities = store.identities.values();
  const name = cardName(card);
  const emails = cardEmails(card);
  const phones = cardPhones(card);
  const photo = usePhoto(cardPhoto(card));
  const birthday = formatBirthday(cardBirthday(card));
  const address = Object.values(card.addresses ?? {})[0]?.full?.trim();
  const notes = Object.values(card.notes ?? {})[0]?.note?.trim();
  const books = store.contacts.books
    .values()
    .filter((book) => card.addressBookIds?.[book.id]);
  const [asking, setAsking] = useState(false);

  // The mail there has been with them lately, by any of their addresses.
  const addresses = emails.map((each) => each.value).join(' ');
  const [recent, setRecent] = useState<Email[]>([]);
  useEffect(() => {
    setRecent([]);
    if (addresses === '') return undefined;
    let current = true;
    const batch = client.batch();
    const found = batch.call('Email/query', {
      filter: {
        operator: 'OR',
        conditions: addresses
          .split(' ')
          .flatMap((each) => [{ from: each }, { to: each }]),
      },
      sort: [{ property: 'receivedAt', isAscending: false }],
      collapseThreads: true,
      limit: 4,
    });
    const got = batch.call('Email/get', {
      '#ids': found.ref('/ids'),
      properties: ['threadId', 'subject', 'preview', 'receivedAt'],
    });
    void batch
      .send()
      .then((result) => {
        if (current && result.ok(got)) setRecent(result.get(got).list);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, addresses]);

  const write = (to: string) =>
    compose({
      ...emptyDraft(identities),
      to: [{ name: card.name?.full?.trim() || null, email: to }],
    });
  const remove = async () => {
    const gone = await act(() => store.contacts.remove(card.id));
    if (!gone) return;
    say(`${name} was removed from your contacts`);
    void navigate(`/contacts${query}`);
  };
  const first = emails[0]?.value;

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Contact actions">
        <Link
          className="icon-button back"
          to={`/contacts${query}`}
          aria-label="Back to the contacts"
          title="Back to the contacts"
        >
          <Icon name="back" />
        </Link>
        <Button
          variant="primary"
          className="button-pill"
          icon="mail"
          disabled={!first || identities.length === 0}
          onClick={() => first && write(first)}
        >
          Write
        </Button>
        <Link
          className="button button-pill button-with-icon"
          to={`/contacts/${card.id}/edit${query}`}
        >
          <Icon name="write" size={18} />
          Edit
        </Link>
        <span className="toolbar-gap" />
        <More
          label="More for this contact"
          choices={[
            {
              label: 'Delete this contact',
              icon: 'delete',
              act: () => setAsking(true),
            },
          ]}
        />
      </div>
      <div className="contact-body">
        {asking ? (
          <div
            className="notice notice-warning"
            role="alertdialog"
            aria-label="Delete the contact"
          >
            <p>Remove {name} from your contacts? Their mail stays.</p>
            <div className="row">
              <button
                type="button"
                className="button button-small button-danger"
                onClick={() => void remove()}
              >
                Delete
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setAsking(false)}
              >
                Keep
              </button>
            </div>
          </div>
        ) : null}
        <header className="contact-head">
          <Face name={name} photo={photo} />
          <div className="contact-names">
            <h1>{name}</h1>
            {cardAbout(card) ? (
              <span className="muted">{cardAbout(card)}</span>
            ) : null}
            <span className="row">
              {books.map((book) => (
                <Tag key={book.id}>{book.name}</Tag>
              ))}
            </span>
          </div>
        </header>
        {emails.length > 0 ? (
          <Detail icon="mail" label="Email">
            {emails.map((each, index) => (
              <div key={index} className="contact-value">
                <span>
                  <span className="contact-value-text">{each.value}</span>
                  <span className="muted small">{KIND_NAMES[each.kind]}</span>
                </span>
                <button
                  type="button"
                  className="button button-small button-pill"
                  aria-label={`Write to ${each.value}`}
                  disabled={identities.length === 0}
                  onClick={() => write(each.value)}
                >
                  Write
                </button>
              </div>
            ))}
          </Detail>
        ) : null}
        {phones.length > 0 ? (
          <Detail icon="phone" label="Phone">
            {phones.map((each, index) => (
              <div key={index} className="contact-value">
                <span>
                  <span className="contact-value-text">{each.value}</span>
                  <span className="muted small">{KIND_NAMES[each.kind]}</span>
                </span>
                <a
                  className="button button-small button-pill"
                  href={`tel:${each.value.replace(/[^\d+]/g, '')}`}
                  aria-label={`Call ${each.value}`}
                >
                  Call
                </a>
              </div>
            ))}
          </Detail>
        ) : null}
        {address ? (
          <Detail icon="place" label="Address">
            <span className="contact-value-text">{address}</span>
          </Detail>
        ) : null}
        {birthday ? (
          <Detail icon="birthday" label="Birthday">
            <span>
              <span className="contact-value-text">{birthday}</span>
              <span className="muted small">Birthday</span>
            </span>
          </Detail>
        ) : null}
        {notes ? (
          <Detail icon="note" label="Notes">
            <span className="contact-notes">{notes}</span>
          </Detail>
        ) : null}
        {recent.length > 0 && first ? (
          <section className="contact-mail" aria-label="Recent mail">
            <div className="contact-mail-head">
              <h2>Recent mail</h2>
              <Link to={`/search?q=${encodeURIComponent(first)}`}>
                All mail with {name}
              </Link>
            </div>
            <ul>
              {recent.map((email) => (
                <li key={email.id}>
                  <Link
                    className="contact-mail-row"
                    to={`/search/${email.threadId}?q=${encodeURIComponent(first)}`}
                  >
                    <span className="contact-mail-text">
                      <strong>{email.subject || '(no subject)'}</strong>{' '}
                      <span className="muted">· {email.preview}</span>
                    </span>
                    <time className="muted small" dateTime={email.receivedAt}>
                      {formatWhen(email.receivedAt)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}

const KINDS: Record<'emails' | 'phones', Kind[]> = {
  emails: ['work', 'home', 'other'],
  phones: ['mobile', 'work', 'home', 'other'],
};

interface RowsProps {
  what: 'emails' | 'phones';
  label: string;
  add: string;
  rows: CardForm['emails'];
  onChange(rows: CardForm['emails']): void;
}

/** The addresses or the numbers of someone: as many as they have, each of a kind. */
function Rows({ what, label, add, rows, onChange }: RowsProps) {
  const set = (index: number, change: Partial<CardForm['emails'][number]>) =>
    onChange(
      rows.map((row, each) => (each === index ? { ...row, ...change } : row)),
    );
  return (
    <fieldset className="contact-rows">
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div key={index} className="contact-rows-row">
          <select
            aria-label={`Kind of ${label.toLowerCase()} ${index + 1}`}
            value={row.kind}
            onChange={(event) =>
              set(index, { kind: event.target.value as Kind })
            }
          >
            {KINDS[what].map((kind) => (
              <option key={kind} value={kind}>
                {KIND_NAMES[kind]}
              </option>
            ))}
          </select>
          <input
            aria-label={`${label} ${index + 1}`}
            type={what === 'emails' ? 'email' : 'tel'}
            value={row.value}
            onChange={(event) => set(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            title="Remove"
            onClick={() => onChange(rows.filter((_, each) => each !== index))}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button button-small button-quiet"
        onClick={() =>
          onChange([...rows, { kind: KINDS[what][0] as Kind, value: '' }])
        }
      >
        {add}
      </button>
    </fieldset>
  );
}

interface CardEditorProps {
  /** The person being changed. Nobody, for someone new. */
  card: Card | undefined;
  /** Where leaving the form leads. */
  back: string;
  query: string;
  /** The book being looked at, which someone new goes in. */
  bookId: string | undefined;
}

/** The form to add someone, or to change what is kept of them. */
function CardEditor({ card, back, query, bookId }: CardEditorProps) {
  const { client } = useServices();
  const { store, say } = useMail();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const books = store.contacts.books.values();
  const [form, setForm] = useState<CardForm>(() => {
    const start = formOf(
      card,
      bookId ?? store.contacts.defaultBook()?.id ?? '',
    );
    if (card) return start;
    // Someone met in a message comes with what the message said of them.
    const email = params.get('email');
    return {
      ...start,
      name: params.get('name') ?? '',
      emails: [{ kind: 'work', value: email ?? '' }],
      phones: [{ kind: 'mobile', value: '' }],
    };
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** A picture just chosen, shown from this browser's copy until it is kept. */
  const [chosen, setChosen] = useState<string | null>(null);
  const kept = usePhoto(chosen ? null : form.photo);
  const file = useRef<HTMLInputElement>(null);
  const name = form.name.trim() || form.company.trim() || 'New contact';
  const change = (changes: Partial<CardForm>) => {
    setForm((before) => ({ ...before, ...changes }));
    setProblem(null);
  };

  const choose = async (picked: File | undefined) => {
    if (!picked) return;
    if (!isPicture(picked)) {
      setProblem('A photo is a PNG, JPEG, GIF or WebP picture.');
      return;
    }
    setBusy(true);
    try {
      const uploaded = await client.upload(picked, { type: picked.type });
      setChosen(URL.createObjectURL(picked));
      change({ photo: uploaded.blobId });
    } catch {
      setProblem('The photo could not be uploaded.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const wrong = formProblem(form);
    if (wrong) return setProblem(wrong);
    setBusy(true);
    try {
      const id = await store.contacts.save(card?.id ?? null, cardOf(form));
      say(card ? 'Saved' : `${name} was added to your contacts`);
      void navigate(`/contacts/${id}${query}`);
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : 'The contact could not be kept.',
      );
      setBusy(false);
    }
  };

  return (
    <form
      className="contact-form"
      aria-label={card ? `Edit ${cardName(card)}` : 'New contact'}
      // What is wrong is said here, in this page's words, not in the browser's.
      noValidate
      onSubmit={(event) => void save(event)}
    >
      <div className="toolbar">
        <strong>{card ? 'Edit contact' : 'New contact'}</strong>
        <span className="toolbar-gap" />
        <Link className="button button-pill" to={back}>
          Cancel
        </Link>
        <Button
          type="submit"
          variant="primary"
          className="button-pill"
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="contact-body">
        {problem ? (
          <p className="notice notice-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="contact-head">
          <Face name={name} photo={chosen ?? kept} />
          <div className="row">
            <label className="button button-pill">
              Choose a photo
              <input
                ref={file}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="visually-hidden"
                disabled={busy}
                onChange={(event) => void choose(event.target.files?.[0])}
              />
            </label>
            {form.photo ? (
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setChosen(null);
                  change({ photo: null });
                }}
              >
                Remove the photo
              </button>
            ) : null}
          </div>
        </div>
        <label className="field">
          <span>Name</span>
          <input
            autoFocus={!card}
            value={form.name}
            maxLength={200}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Company</span>
          <input
            value={form.company}
            maxLength={200}
            onChange={(event) => change({ company: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Title</span>
          <input
            value={form.title}
            maxLength={200}
            onChange={(event) => change({ title: event.target.value })}
          />
        </label>
        <Rows
          what="emails"
          label="Email"
          add="Add an email"
          rows={form.emails}
          onChange={(emails) => change({ emails })}
        />
        <Rows
          what="phones"
          label="Phone"
          add="Add a phone"
          rows={form.phones}
          onChange={(phones) => change({ phones })}
        />
        <label className="field">
          <span>Address</span>
          <input
            value={form.address}
            maxLength={500}
            onChange={(event) => change({ address: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Birthday</span>
          <input
            type="date"
            className="contact-date"
            value={form.birthday}
            onChange={(event) => change({ birthday: event.target.value })}
          />
        </label>
        {books.length > 1 ? (
          <label className="field">
            <span>Address book</span>
            <select
              value={form.bookId}
              onChange={(event) => change({ bookId: event.target.value })}
            >
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field field-top">
          <span>Notes</span>
          <textarea
            rows={3}
            value={form.notes}
            maxLength={4000}
            onChange={(event) => change({ notes: event.target.value })}
          />
        </label>
      </div>
    </form>
  );
}
