import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
import { JmapRequestError } from '@mailless/jmap-client';
import type { Mailbox } from '@mailless/jmap-core';
import { Button, Icon, IconButton, ThemeSwitch } from '@mailless/ui';
import { emptyDraft } from '../lib/compose';
import { MailError, MailStore, type Draft } from '../lib/mail';
import { answerPushes, Notifications } from '../lib/notifications';
import { Compose } from './compose';
import { MessageList } from './list';
import { Reader } from './reader';
import { SettingsPage, useNotificationSwitch } from './settings';
import {
  MailProvider,
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

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

/** Mailboxes in the order people look for them: the known ones first, then the rest by name, each under its parent. */
export function orderMailboxes(
  mailboxes: readonly Mailbox[],
): Array<{ mailbox: Mailbox; depth: number }> {
  const rank = (mailbox: Mailbox) => {
    const index = mailbox.role ? ROLE_ORDER.indexOf(mailbox.role) : -1;
    return index === -1 ? ROLE_ORDER.length : index;
  };
  const sorted = [...mailboxes].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
  const ids = new Set(mailboxes.map((mailbox) => mailbox.id));
  const result: Array<{ mailbox: Mailbox; depth: number }> = [];
  const add = (parentId: string | null, depth: number) => {
    for (const mailbox of sorted) {
      const parent =
        mailbox.parentId !== null && ids.has(mailbox.parentId)
          ? mailbox.parentId
          : null;
      if (parent !== parentId) continue;
      result.push({ mailbox, depth });
      if (depth < 8) add(mailbox.id, depth + 1);
    }
  };
  add(null, 0);
  return result;
}

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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    problem: boolean;
  } | null>(null);

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
    (text: string) => setNotice({ text, problem: false }),
    [],
  );
  const mail = useMemo<Mail>(
    () => ({ store, compose: setDraft, act, say, notifications }),
    [store, act, say, notifications],
  );

  // What was said in passing goes away by itself; a problem stays until it is closed.
  useEffect(() => {
    if (!notice || notice.problem) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
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

  return (
    <MailProvider value={mail}>
      <div className="shell">
        <TopBar onMenu={() => setMenu((open) => !open)} />
        <div className="body">
          <Rail />
          <Sidebar open={menu} onClose={closeMenu} />
          <Routes>
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
            <button
              type="button"
              className="button button-small"
              onClick={() => setNotice(null)}
            >
              Close
            </button>
          </div>
        ) : null}
        {draft ? (
          <Compose
            // A new message is a new form: nothing of the last one is left in it.
            key={JSON.stringify([draft.replaces, draft.answers, draft.subject])}
            draft={draft}
            onClose={() => setDraft(null)}
          />
        ) : null}
      </div>
    </MailProvider>
  );
}

function TopBar({ onMenu }: { onMenu(): void }) {
  const { session, theme } = useServices();
  const { store, notifications } = useMail();
  useSynced(store.identities);
  const {
    state: notifying,
    switching,
    toggle: toggleNotifications,
  } = useNotificationSwitch();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const searching = location.pathname.startsWith('/search');
  const [text, setText] = useState(searching ? (params.get('q') ?? '') : '');
  const address = store.identities.values()[0]?.email;

  const search = (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    if (query === '') return;
    void navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <header className="topbar">
      <IconButton
        className="menu-button"
        icon="menu"
        label="Mailboxes"
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
      <form className="search" role="search" onSubmit={search}>
        <Icon name="search" size={18} />
        <input
          type="search"
          aria-label="Search mail"
          placeholder="Search mail"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </form>
      <div className="topbar-user">
        {address ? <span className="muted address">{address}</span> : null}
        {theme ? <ThemeSwitch theme={theme} /> : null}
        {notifying === 'unsupported' ? null : (
          <IconButton
            icon="bell"
            label={
              switching
                ? 'Notifications…'
                : notifying === 'on'
                  ? 'Notifications: on'
                  : notifying === 'blocked'
                    ? 'Notifications: blocked'
                    : 'Notifications: off'
            }
            pressed={notifying === 'on'}
            disabled={switching || notifying === 'blocked'}
            onClick={toggleNotifications}
          />
        )}
        <NavLink
          to="/settings"
          className="icon-button"
          aria-label="Settings"
          title="Settings"
        >
          <Icon name="settings" />
        </NavLink>
        <IconButton
          icon="sign-out"
          label="Sign out"
          onClick={() => {
            // Mail is not announced to a browser nobody is signed in to. Not waited for long: signing out comes first.
            void Promise.race([
              notifications.disable().catch(() => undefined),
              new Promise((resolve) => window.setTimeout(resolve, 3000)),
            ]).then(() => session.signOut());
          }}
        />
      </div>
    </header>
  );
}

/** The parts of mailless: mail, and what is on its way. On a phone it sits along the bottom. */
function Rail() {
  return (
    <nav className="rail" aria-label="Sections">
      <NavLink to="/" className="rail-item rail-current" aria-current="page">
        <span className="rail-icon">
          <Icon name="mail" />
        </span>
        Mail
      </NavLink>
      {(['calendar', 'contacts'] as const).map((section) => (
        <span
          key={section}
          className="rail-item rail-soon"
          aria-disabled="true"
          title="Not here yet"
        >
          <span className="rail-icon">
            <Icon name={section} />
          </span>
          {section === 'calendar' ? 'Calendar' : 'Contacts'}
        </span>
      ))}
    </nav>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose(): void }) {
  const { store, compose, act } = useMail();
  useSynced(store.mailboxes);
  useSynced(store.identities);
  const navigate = useNavigate();
  const location = useLocation();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const identities = store.identities.values();
  const ordered = orderMailboxes(store.mailboxes.values());

  useEffect(() => {
    if (adding) field.current?.focus();
  }, [adding]);

  // Going somewhere is what the drawer was opened for.
  useEffect(() => onClose(), [location.pathname, onClose]);

  const inbox = store.mailbox('inbox');
  useEffect(() => {
    const unread = inbox?.unreadEmails ?? 0;
    document.title = unread > 0 ? `(${unread}) mailless` : 'mailless';
  }, [inbox?.unreadEmails]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '' || busy) return;
    setBusy(true);
    let id: string | undefined;
    const made = await act(async () => {
      id = await store.createMailbox(wanted);
    });
    setBusy(false);
    if (!made) return;
    setAdding(false);
    setName('');
    if (id) void navigate(`/box/${id}`);
  };

  return (
    <div className={`side${open ? ' side-open' : ''}`}>
      <Button
        className="write"
        icon="write"
        disabled={identities.length === 0}
        title={
          identities.length === 0 ? 'This account cannot send mail' : undefined
        }
        onClick={() => compose(emptyDraft(identities))}
      >
        Write
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
        <ul className="mailboxes">
          {ordered.map(({ mailbox, depth }) => {
            // Drafts are all still to be done; elsewhere it is the unread that count.
            const count =
              mailbox.role === 'drafts'
                ? mailbox.totalEmails
                : mailbox.unreadEmails;
            return (
              <li key={mailbox.id}>
                <NavLink
                  to={`/box/${mailbox.id}`}
                  className={`mailbox depth-${Math.min(depth, 4)}`}
                >
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
              </li>
            );
          })}
        </ul>
        {adding ? (
          <form className="new-mailbox" onSubmit={(event) => void add(event)}>
            <input
              ref={field}
              aria-label="Name of the new mailbox"
              placeholder="Name"
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="row">
              <Button
                type="submit"
                size="small"
                variant="primary"
                disabled={busy || name.trim() === ''}
              >
                Add
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setAdding(false);
                  setName('');
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            size="small"
            variant="quiet"
            icon="plus"
            className="new-mailbox-button"
            onClick={() => setAdding(true)}
          >
            New mailbox
          </Button>
        )}
      </nav>
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
    <main className={`panes${threadId ? ' has-thread' : ''}`}>
      <MessageList
        listKey={listKey}
        title={mailbox.name}
        mailbox={mailbox}
        base={base}
        suffix=""
        threadId={threadId}
      />
      {threadId ? (
        <Reader
          // Another conversation is another reader: what was open in the last one is not open in this.
          key={threadId}
          threadId={threadId}
          mailbox={mailbox}
          back={base}
        />
      ) : (
        <section className="reader reader-empty" aria-label="Conversation">
          <p className="muted">Choose a conversation to read it.</p>
        </section>
      )}
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
    <main className={`panes${threadId ? ' has-thread' : ''}`}>
      <MessageList
        listKey={listKey}
        title={`Search: ${query}`}
        base="/search"
        suffix={suffix}
        threadId={threadId}
      />
      {threadId ? (
        <Reader key={threadId} threadId={threadId} back={`/search${suffix}`} />
      ) : (
        <section className="reader reader-empty" aria-label="Conversation">
          <p className="muted">Choose a conversation to read it.</p>
        </section>
      )}
    </main>
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
