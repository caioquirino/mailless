import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router';
import { JmapRequestError } from '@mailless/jmap-client';
import type { Mailbox } from '@mailless/jmap-core';
import { Button, Icon, IconButton, type IconName } from '@mailless/ui';
import { emptyDraft, resumeDraft } from '../lib/compose';
import { MailError, MailStore, type Draft, type Held } from '../lib/mail';
import { orderMailboxes } from '../lib/mailboxes';
import { answerPushes, Notifications } from '../lib/notifications';
import { usePreference } from '../lib/preference';
import { formatSearch, NO_SEARCH } from '../lib/search';
import { MessageList } from './list';
import { ProfileMenu } from './profile';
import { PullMark, usePull } from './pull';
import { Rail } from './rail';
import { Reader } from './reader';
import { SearchBar } from './search';
import { SettingsPage } from './settings';
import {
  MailProvider,
  type SayOptions,
  useMail,
  useServices,
  useSynced,
  type Mail,
} from './services';

/** How often to ask the server what changed while the page is being looked at. */
const REFRESH_MS = 60_000;

/** What to tell the user about something that went wrong, or null when there is nothing to tell. */
function explain(error: unknown): string | null {
  if (error instanceof MailError) return error.message;
  if (error instanceof JmapRequestError) {
    // Signed out: the sign-in page says so itself.
    if (error.status === 401) return null;
    if (error.status === 429) {
      return 'The server is busy. Wait a moment and try again.';
    }
    return 'The server could not do that. Please try again.';
  }
  return 'The server could not be reached. Check your connection and try again.';
}

const Compose = lazy(() =>
  import('./compose').then((module) => ({ default: module.Compose })),
);

/** How many messages may be open for writing at once: what fits beside each other. */
const MOST_WRITTEN_AT_ONCE = 3;

const ContactsPage = lazy(() =>
  import('./contacts').then((module) => ({ default: module.ContactsPage })),
);

/** The screens of someone signed in. */
export function MailShell() {
  const { client, push } = useServices();
  // Made when someone signs in and dropped when they sign out: nothing of one user's mail is left for the next.
  const store = useMemo(() => new MailStore(client), [client]);
  const notifications = useMemo(
    () =>
      new Notifications({
        client,
        // Without a browser to notify, there is nothing to turn on.
        ...(push ?? {
          storage: window.localStorage,
          serviceWorker: undefined,
          workerUrl: '',
          scope: '',
          permission: () => undefined,
          requestPermission: async () => 'denied' as const,
          now: () => Date.now(),
        }),
      }),
    [client, push],
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(
    'loading',
  );
  const [attempt, setAttempt] = useState(0);
  // On a narrow screen the mailboxes are a drawer, opened from the top bar.
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  const inContacts = useLocation().pathname.startsWith('/contacts');
  // On a wide one they fold down to their icons, and stay as they were left.
  const [folded, setFolded] = usePreference<boolean>(
    'mailless.mail.sidebar-folded',
    false,
  );
  const toggleMenu = () => {
    const narrow =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 48rem)').matches;
    if (narrow) setMenu((open) => !open);
    else setFolded(!folded);
  };
  /** The messages being written: each in a window of its own, one of them in front. */
  const [writing, setWriting] = useState<Array<{ key: string; draft: Draft }>>(
    [],
  );
  const [front, setFront] = useState<string | null>(null);
  const open = useRef({ writing, made: 0 });
  open.current.writing = writing;
  const [notice, setNotice] = useState<
    ({ text: string; problem: boolean } & SayOptions) | null
  >(null);

  useEffect(() => {
    let current = true;
    setStatus('loading');
    store.start().then(
      () => current && setStatus('ready'),
      () => current && setStatus('failed'),
    );
    return () => {
      current = false;
    };
  }, [store, attempt]);

  useEffect(() => {
    if (status !== 'ready') return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      // Quietly: the next one says the same, and a banner every minute helps nobody.
      void store.refresh().catch(() => undefined);
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [store, status]);

  useEffect(() => {
    if (status !== 'ready') return;
    // The address book, for the pictures of whoever is in it. Mail is shown without waiting for it.
    void store.contacts.start().catch(() => undefined);
    // What was chosen before on this browser is picked up; failing to is not worth a word.
    void notifications.start().catch(() => undefined);
    return answerPushes(
      push?.serviceWorker,
      store,
      () => document.visibilityState === 'visible' && document.hasFocus(),
    );
  }, [status, notifications, push, store]);

  const act = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch (error) {
      const text = explain(error);
      if (text !== null) setNotice({ text, problem: true });
      return false;
    }
  }, []);
  const say = useCallback(
    (text: string, options: SayOptions = {}) =>
      setNotice({ text, problem: false, ...options }),
    [],
  );
  const compose = useCallback(
    (draft: Draft) => {
      const { writing: now } = open.current;
      // A draft or an answer already being written is gone on with where it is.
      const there = now.find(
        (each) =>
          (draft.replaces !== undefined &&
            each.draft.replaces === draft.replaces) ||
          (draft.answers !== undefined &&
            JSON.stringify(each.draft.answers) ===
              JSON.stringify(draft.answers)),
      );
      if (there) return setFront(there.key);
      if (now.length >= MOST_WRITTEN_AT_ONCE) {
        return say(
          'Close one of the messages you are writing to start another.',
        );
      }
      const key = `writing-${++open.current.made}`;
      setWriting([...now, { key, draft }]);
      setFront(key);
    },
    [say],
  );
  const closeWriting = useCallback((key: string) => {
    const left = open.current.writing.filter((each) => each.key !== key);
    setWriting(left);
    setFront((now) => (now === key ? (left.at(-1)?.key ?? null) : now));
  }, []);
  const unsend = useCallback(
    async (held: Pick<Held, 'submissionId' | 'emailId'>) => {
      await act(async () => {
        await store.unsend(held);
        const email = store.emails.get(held.emailId);
        // Back among the drafts, and open to go on with.
        if (email) compose(resumeDraft(email, store.identities.values()));
      });
    },
    [store, act, compose],
  );
  // Pulled down on a phone: what changed is asked for, and the page stays as it is.
  const pull = usePull(() =>
    act(() => Promise.all([store.refresh(), store.contacts.refresh()])),
  );
  const mail = useMemo<Mail>(
    () => ({ store, compose, act, say, unsend, notifications }),
    [store, compose, act, say, unsend, notifications],
  );

  // What was said in passing goes away by itself; a problem stays until it is closed.
  useEffect(() => {
    if (!notice || notice.problem) return;
    const timer = window.setTimeout(
      () => setNotice(null),
      (notice.seconds ?? 4) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (status === 'loading') {
    return (
      <main className="centered">
        <p role="status" className="muted">
          Loading your mail…
        </p>
      </main>
    );
  }
  if (status === 'failed') {
    return (
      <main className="centered">
        <div className="card card-narrow">
          <h1>mailless</h1>
          <p className="notice notice-error" role="alert">
            Your mail could not be loaded. Check your connection and try again.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  const drawer = { menu, folded, onCloseMenu: closeMenu };
  return (
    <MailProvider value={mail}>
      <div className="shell">
        <TopBar onMenu={toggleMenu} />
        <div className="body" {...pull.touch}>
          <PullMark pull={pull} />
          {inContacts ? null : (
            <Sidebar open={menu} folded={folded} onClose={closeMenu} />
          )}
          <Routes>
            <Route path="/contacts" element={<ContactsRoute {...drawer} />} />
            <Route
              path="/contacts/new"
              element={<ContactsRoute adding {...drawer} />}
            />
            <Route
              path="/contacts/:cardId"
              element={<ContactsRoute {...drawer} />}
            />
            <Route
              path="/contacts/:cardId/edit"
              element={<ContactsRoute editing {...drawer} />}
            />
            <Route path="/" element={<ToInbox />} />
            <Route path="/box/:mailboxId" element={<MailboxPage />} />
            <Route path="/box/:mailboxId/:threadId" element={<MailboxPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/search/:threadId" element={<SearchPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
        {notice ? (
          <div
            className={`toast${notice.problem ? ' toast-error' : ''}`}
            role={notice.problem ? 'alert' : 'status'}
          >
            <span>{notice.text}</span>
            {notice.action ? (
              <button
                type="button"
                className="button button-small toast-action"
                onClick={() => {
                  const { act: taken } = notice.action as { act(): void };
                  setNotice(null);
                  taken();
                }}
              >
                {notice.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="button button-small"
              onClick={() => setNotice(null)}
            >
              Close
            </button>
          </div>
        ) : null}
        {writing.length > 0 ? (
          // The editor is a good part of the page's weight: fetched when first written with.
          <Suspense fallback={null}>
            <div className="compose-dock">
              {writing.map((each) => (
                <Compose
                  key={each.key}
                  draft={each.draft}
                  front={each.key === front}
                  onFront={() => setFront(each.key)}
                  onClose={() => closeWriting(each.key)}
                />
              ))}
            </div>
          </Suspense>
        ) : null}
      </div>
    </MailProvider>
  );
}

function TopBar({ onMenu }: { onMenu(): void }) {
  return (
    <header className="topbar">
      <IconButton
        className="menu-button"
        icon="menu"
        label="Menu"
        onClick={onMenu}
      />
      <NavLink to="/" className="brand">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
          <rect className="brand-ground" width="32" height="32" rx="7" />
          <path
            className="brand-mark"
            d="M7 11h18v11H7z M7.5 11.5 16 18l8.5-6.5"
          />
        </svg>
        <span className="brand-name">mailless</span>
      </NavLink>
      <SearchBar />
      <div className="topbar-user">
        <NavLink
          to="/settings"
          className="icon-button topbar-settings"
          aria-label="Settings"
          title="Settings"
        >
          <Icon name="settings" />
        </NavLink>
        <ProfileMenu />
      </div>
    </header>
  );
}

/** The address book, which is fetched when it is first gone to. */
function ContactsRoute(props: {
  editing?: boolean;
  adding?: boolean;
  menu: boolean;
  folded: boolean;
  onCloseMenu(): void;
}) {
  const { cardId } = useParams();
  return (
    <Suspense fallback={null}>
      <ContactsPage
        cardId={props.adding ? 'new' : cardId}
        editing={props.editing === true}
        menu={props.menu}
        folded={props.folded}
        onCloseMenu={props.onCloseMenu}
      />
    </Suspense>
  );
}

const ROLE_ICONS: Record<string, IconName> = {
  inbox: 'inbox',
  drafts: 'file',
  sent: 'send',
  archive: 'archive',
  junk: 'junk',
  trash: 'delete',
};

/** The mailboxes every account has and nobody looks for often: under "More". */
const MORE_ROLES = ['archive', 'junk', 'trash'];

function Sidebar({
  open,
  folded,
  onClose,
}: {
  open: boolean;
  /** Down to its icons, on a wide screen. */
  folded: boolean;
  onClose(): void;
}) {
  const { store, compose } = useMail();
  useSynced(store.mailboxes);
  useSynced(store.identities);
  const location = useLocation();
  const identities = store.identities.values();
  const ordered = orderMailboxes(store.mailboxes.values());
  // Each part of the list folds away, and stays as it was left.
  const [foldersOpen, setFoldersOpen] = usePreference<boolean>(
    'mailless.mail.folders-open',
    true,
  );
  const [moreOpen, setMoreOpen] = usePreference<boolean>(
    'mailless.mail.more-open',
    true,
  );
  const [tagsOpen, setTagsOpen] = usePreference<boolean>(
    'mailless.mail.tags-open',
    true,
  );
  useSynced(store.tags.made);
  const searching = new URLSearchParams(location.search).get('q') ?? '';
  /** The folders whose own folders are put away: their ids, as kept. */
  const [shut, setShut] = usePreference<string>(
    'mailless.mail.folders-shut',
    '',
  );
  const shutIds = new Set(shut === '' ? [] : shut.split(' '));
  const toggle = (id: string) => {
    const next = new Set(shutIds);
    if (!next.delete(id)) next.add(id);
    setShut([...next].join(' '));
  };

  // Going somewhere is what the drawer was opened for.
  useEffect(() => onClose(), [location.pathname, onClose]);

  const inbox = store.mailbox('inbox');
  useEffect(() => {
    const unread = inbox?.unreadEmails ?? 0;
    document.title = unread > 0 ? `(${unread}) mailless` : 'mailless';
  }, [inbox?.unreadEmails]);

  // Which part each mailbox is in goes by the one at the top of its branch.
  type Entry = { mailbox: Mailbox; depth: number; parent: boolean };
  const parts: Record<'main' | 'folders' | 'more', Entry[]> = {
    main: [],
    folders: [],
    more: [],
  };
  let part: keyof typeof parts = 'main';
  /** How deep the folder being skipped past is, with everything inside it. */
  let hidden: number | null = null;
  ordered.forEach(({ mailbox, depth }, index) => {
    if (depth === 0) {
      part =
        mailbox.role === null
          ? 'folders'
          : MORE_ROLES.includes(mailbox.role)
            ? 'more'
            : 'main';
    }
    if (hidden !== null && depth > hidden) return;
    hidden = null;
    const parent = (ordered[index + 1]?.depth ?? 0) > depth;
    parts[part].push({ mailbox, depth, parent });
    if (parent && shutIds.has(mailbox.id)) hidden = depth;
  });
  /** What waits in a part that is folded away: said on its heading. */
  const unreadIn = (name: 'folders' | 'more') =>
    ordered.reduce((sum, { mailbox }, index) => {
      let top = index;
      while ((ordered[top]?.depth ?? 0) > 0) top--;
      const role = ordered[top]?.mailbox.role ?? null;
      const within = role === null ? 'folders' : 'more';
      return role !== null && !MORE_ROLES.includes(role)
        ? sum
        : within === name
          ? sum + mailbox.unreadEmails
          : sum;
    }, 0);

  const rows = (entries: Entry[]) => (
    <ul className="mailboxes">
      {entries.map(({ mailbox, depth, parent }) => {
        // Drafts are all still to be done; elsewhere it is the unread that count.
        const count =
          mailbox.role === 'drafts'
            ? mailbox.totalEmails
            : mailbox.unreadEmails;
        const closed = shutIds.has(mailbox.id);
        return (
          <li key={mailbox.id} className="mailbox-line">
            <NavLink
              to={`/box/${mailbox.id}`}
              className={`mailbox depth-${Math.min(depth, 4)}${
                parent ? ' mailbox-parent' : ''
              }`}
              title={mailbox.name}
            >
              <Icon
                name={ROLE_ICONS[mailbox.role ?? ''] ?? 'folder'}
                size={18}
              />
              <span className="mailbox-name">{mailbox.name}</span>
              {count > 0 ? (
                <span
                  className="count"
                  aria-label={
                    mailbox.role === 'drafts'
                      ? `${count} drafts`
                      : `${count} unread`
                  }
                >
                  {count}
                </span>
              ) : null}
            </NavLink>
            {parent ? (
              <button
                type="button"
                className={`mailbox-fold depth-${Math.min(depth, 4)}`}
                aria-expanded={!closed}
                aria-label={`${closed ? 'Show' : 'Hide'} what is inside ${mailbox.name}`}
                onClick={() => toggle(mailbox.id)}
              >
                <Icon
                  name={closed ? 'chevron-right' : 'chevron-down'}
                  size={14}
                />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
  const section = (
    name: 'folders' | 'more',
    label: string,
    isOpen: boolean,
    set: (open: boolean) => void,
  ) => {
    if (parts[name].length === 0) return null;
    const waiting = isOpen ? 0 : unreadIn(name);
    return (
      <>
        <button
          type="button"
          className="side-section"
          aria-expanded={isOpen}
          onClick={() => set(!isOpen)}
        >
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
          <span className="side-section-name">{label}</span>
          {waiting > 0 ? (
            <span
              className="side-section-count"
              aria-label={`${waiting} unread`}
            >
              {waiting}
            </span>
          ) : null}
        </button>
        {isOpen ? rows(parts[name]) : null}
      </>
    );
  };

  return (
    <div
      className={`side${open ? ' side-open' : ''}${folded ? ' side-folded' : ''}`}
    >
      <Button
        className="write"
        icon="write"
        disabled={identities.length === 0}
        title={
          identities.length === 0 ? 'This account cannot send mail' : undefined
        }
        onClick={() => compose(emptyDraft(identities))}
      >
        <span className="write-label">Write</span>
      </Button>
      {open ? (
        <button
          type="button"
          className="side-backdrop"
          aria-label="Close the list of mailboxes"
          onClick={onClose}
        />
      ) : null}
      <nav className="sidebar" aria-label="Mailboxes">
        {rows(parts.main)}
        {section('folders', 'Folders', foldersOpen, setFoldersOpen)}
        <button
          type="button"
          className="side-section"
          aria-expanded={tagsOpen}
          onClick={() => setTagsOpen(!tagsOpen)}
        >
          <Icon name={tagsOpen ? 'chevron-down' : 'chevron-right'} size={14} />
          <span className="side-section-name">Tags</span>
        </button>
        {tagsOpen ? (
          <ul className="mailboxes">
            {store.tags.all().map((tag) => {
              // What has a tag is found by searching for it, wherever it is.
              const asked =
                tag.fixed === 'starred'
                  ? 'is:starred'
                  : formatSearch({ ...NO_SEARCH, tags: tag.name });
              return (
                <li key={tag.id}>
                  <Link
                    to={`/search?q=${encodeURIComponent(asked)}`}
                    className={`mailbox${
                      location.pathname.startsWith('/search') &&
                      searching === asked
                        ? ' active'
                        : ''
                    }`}
                    title={tag.name}
                    style={{ '--tag': tag.color } as CSSProperties}
                  >
                    {tag.fixed === 'starred' ? (
                      <span className="tag-star">
                        <Icon name="flag" size={18} />
                      </span>
                    ) : (
                      <span
                        className="tag-dot tag-dot-menu"
                        aria-hidden="true"
                      />
                    )}
                    <span className="mailbox-name">{tag.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
        {section('more', 'More', moreOpen, setMoreOpen)}
        {/* On a phone the bar at the top has no room for it. */}
        <NavLink to="/settings" className="mailbox side-settings">
          <Icon name="settings" size={18} />
          <span className="mailbox-name">Settings</span>
        </NavLink>
      </nav>
      <Rail />
    </div>
  );
}

function ToInbox() {
  const { store } = useMail();
  useSynced(store.mailboxes);
  const first =
    store.mailbox('inbox') ??
    orderMailboxes(store.mailboxes.values())[0]?.mailbox;
  if (!first) {
    return (
      <main className="panes">
        <p className="muted pad">This account has no mailboxes.</p>
      </main>
    );
  }
  return <Navigate to={`/box/${first.id}`} replace />;
}

function MailboxPage() {
  const { mailboxId = '', threadId } = useParams();
  const { store } = useMail();
  useSynced(store.mailboxes);
  const mailbox = store.mailboxes.get(mailboxId);
  const listKey = useMemo(() => ({ mailboxId }), [mailboxId]);
  if (!mailbox) return <NotFound />;
  const base = `/box/${mailbox.id}`;
  return (
    <Panes
      open={threadId !== undefined}
      list={
        <MessageList
          listKey={listKey}
          title={mailbox.name}
          mailbox={mailbox}
          base={base}
          suffix=""
          threadId={threadId}
        />
      }
      reader={
        threadId ? (
          <Reader
            // Another conversation is another reader: what was open in the last one is not open in this.
            key={threadId}
            threadId={threadId}
            mailbox={mailbox}
            back={base}
            backTo={mailbox.name}
          />
        ) : null
      }
    />
  );
}

/** How narrow the list and the conversation beside it may each be made, in pixels. */
const NARROWEST_LIST = 260;
const NARROWEST_READER = 360;

/**
 * The list, and beside it the conversation chosen from it. With nothing
 * chosen the list has the whole width; with something chosen the two share
 * it, divided where the person last put the divider.
 */
function Panes(props: { open: boolean; list: ReactNode; reader: ReactNode }) {
  const [width, setWidth] = usePreference<number>(
    'mailless.mail.list-width',
    400,
  );
  const panes = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);

  const fit = (wanted: number) => {
    const room = panes.current?.getBoundingClientRect().width ?? 0;
    const widest = room > 0 ? room - NARROWEST_READER : Number.MAX_SAFE_INTEGER;
    return Math.round(
      Math.max(
        NARROWEST_LIST,
        Math.min(wanted, Math.max(widest, NARROWEST_LIST)),
      ),
    );
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const left = panes.current?.getBoundingClientRect().left ?? 0;
    setWidth(fit(event.clientX - left));
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0;
    if (step === 0) return;
    event.preventDefault();
    setWidth(fit(width + step));
  };

  return (
    <main
      ref={panes}
      className={`panes${props.open ? ' has-thread' : ''}${
        dragging ? ' dragging' : ''
      }`}
      style={
        props.open
          ? ({ '--list-width': `${width}px` } as CSSProperties)
          : undefined
      }
    >
      {props.list}
      {props.open ? (
        <>
          <div
            className="divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Width of the list"
            aria-valuenow={width}
            aria-valuemin={NARROWEST_LIST}
            tabIndex={0}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={drag}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onKeyDown={nudge}
          />
          {props.reader}
        </>
      ) : null}
    </main>
  );
}

function SearchPage() {
  const { threadId } = useParams();
  const [params] = useSearchParams();
  const query = (params.get('q') ?? '').trim();
  const listKey = useMemo(() => ({ search: query }), [query]);
  if (query === '') return <Navigate to="/" replace />;
  const suffix = `?q=${encodeURIComponent(query)}`;
  return (
    <Panes
      open={threadId !== undefined}
      list={
        <MessageList
          listKey={listKey}
          title={`Search: ${query}`}
          base="/search"
          suffix={suffix}
          threadId={threadId}
        />
      }
      reader={
        threadId ? (
          <Reader
            key={threadId}
            threadId={threadId}
            back={`/search${suffix}`}
            backTo="what was found"
          />
        ) : null
      }
    />
  );
}

function NotFound() {
  return (
    <main className="panes">
      <div className="pad">
        <h1>Not found</h1>
        <p className="muted">There is nothing at this address.</p>
        <p>
          <NavLink to="/">Go to the inbox</NavLink>
        </p>
      </div>
    </main>
  );
}
