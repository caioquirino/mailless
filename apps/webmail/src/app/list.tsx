import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Email, Id, Mailbox } from '@mailless/jmap-core';
import { Button, Icon, IconButton, Tag } from '@mailless/ui';
import { nameOf } from '../lib/addresses';
import { canView, openAttachment } from '../lib/attachments';
import { formatWhen } from '../lib/format';
import type { Attachment, ListKey, MailStore } from '../lib/mail';
import { Face } from './face';
import { useMail, useServices, useSynced } from './services';

/** One row: a conversation, as the newest of its messages that the list found. */
interface Row {
  id: Id;
  email: Email;
  /** The messages of the conversation an action on the row is about. */
  scope: Email[];
  count: number;
  unread: boolean;
  flagged: boolean;
  who: string;
  /** Whose face stands for the row: who wrote last, or who it is going to. */
  face: string;
  /** Their address, by which their picture is found. */
  faceEmail: string | undefined;
  /** What is attached anywhere in the conversation. */
  files: Attachment[];
}

function people(emails: readonly Email[], outgoing: boolean): string {
  const names: string[] = [];
  for (const email of emails) {
    for (const address of (outgoing ? email.to : email.from) ?? []) {
      const name = nameOf(address);
      if (!names.includes(name)) names.push(name);
    }
  }
  if (names.length === 0) return outgoing ? '(nobody yet)' : '(unknown)';
  const shown = names.slice(0, 3).join(', ');
  const text = names.length > 3 ? `${shown} +${names.length - 3}` : shown;
  return outgoing ? `To: ${text}` : text;
}

function nameOfFirst(addresses: Email['from']): string {
  const first = addresses?.[0];
  return first ? nameOf(first) : '?';
}

function rowsOf(
  store: MailStore,
  ids: readonly Id[],
  mailbox: Mailbox | undefined,
): Row[] {
  const outgoing = mailbox?.role === 'sent' || mailbox?.role === 'drafts';
  const rows: Row[] = [];
  for (const id of ids) {
    const email = store.emails.get(id);
    if (!email) continue;
    const all = store.conversation(email.threadId);
    const conversation = all.length > 0 ? all : [email];
    // In a mailbox, what is done to a row is done to the messages that are in it.
    const within = mailbox
      ? conversation.filter((each) => each.mailboxIds[mailbox.id])
      : conversation;
    const scope = within.length > 0 ? within : [email];
    rows.push({
      id,
      email,
      scope,
      count: conversation.length,
      unread: scope.some((each) => !each.keywords['$seen']),
      flagged: conversation.some((each) => each.keywords['$flagged']),
      who: people(outgoing ? [email] : conversation, outgoing),
      files: conversation.flatMap((each) =>
        (each.attachments ?? [])
          // A picture shown inside the message is part of what it says, not something attached to it.
          .filter(
            (part) =>
              part.blobId !== null &&
              !(part.disposition === 'inline' && part.cid),
          )
          .map((part) => ({
            blobId: part.blobId as string,
            name: part.name ?? 'attachment',
            type: part.type,
            size: part.size,
          })),
      ),
      face: nameOfFirst(
        outgoing ? email.to : (conversation.at(-1) ?? email).from,
      ),
      faceEmail: (outgoing
        ? email.to
        : (conversation.at(-1) ?? email).from)?.[0]?.email,
    });
  }
  return rows;
}

export interface MessageListProps {
  listKey: ListKey;
  title: string;
  /** The mailbox being shown, when it is one and not a search. */
  mailbox?: Mailbox;
  /** Where a conversation of this list is read: its id follows. */
  base: string;
  /** What follows the id in the address: the search, for a search. */
  suffix: string;
  /** The conversation being read. */
  threadId: string | undefined;
}

export function MessageList(props: MessageListProps) {
  const { listKey, title, mailbox, base, suffix, threadId } = props;
  const { client } = useServices();
  const { store, act, say } = useMail();
  const navigate = useNavigate();
  const view = useMemo(() => store.list(listKey), [store, listKey]);
  useSynced(view);
  useSynced(store.emails);
  useSynced(store.threads);
  useSynced(store.mailboxes);
  useSynced(store.held);
  const [selected, setSelected] = useState<ReadonlySet<Id>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setSelected(new Set());
    setConfirming(false);
    let current = true;
    setFailed(false);
    void act(() => store.open(view)).then(
      (opened) => current && setFailed(!opened),
    );
    return () => {
      current = false;
    };
  }, [store, view, act]);

  const rows = rowsOf(store, view.ids, mailbox);
  const chosen = rows.filter((row) => selected.has(row.id));
  const chosenEmails = chosen.flatMap((row) => row.scope);
  const chosenIds = chosenEmails.map((email) => email.id);
  const allChosen = rows.length > 0 && chosen.length === rows.length;
  const anyUnread = chosen.some((row) => row.unread);
  const archive = store.mailbox('archive');
  const trash = store.mailbox('trash');
  const inTrash = mailbox !== undefined && mailbox.id === trash?.id;
  const emptiable =
    mailbox !== undefined &&
    (mailbox.role === 'trash' || mailbox.role === 'junk') &&
    mailbox.totalEmails > 0;

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    // What is being read is among what is being taken away: go back to the list.
    const reading = chosen.some((row) => row.email.threadId === threadId);
    const worked = await act(action);
    setBusy(false);
    if (!worked) return;
    setSelected(new Set());
    if (done) say(done);
    return reading;
  };
  const leave = async (action: () => Promise<unknown>, done: string) => {
    if ((await run(action, done)) === true) void navigate(`${base}${suffix}`);
  };
  /** With the whole width to itself, each row has its own actions. */
  const wide = threadId === undefined;
  const ids = (row: Row) => row.scope.map((email) => email.id);
  const named = (row: Row) => row.email.subject || 'no subject';
  /** Something done to one row, whatever is selected. */
  const one = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    const worked = await act(action);
    setBusy(false);
    if (worked && done) say(done);
  };
  const several = (count: number, one: string, many: string) =>
    count === 1 ? one : `${count} ${many}`;

  return (
    <section className={`list${wide ? ' list-wide' : ''}`} aria-label={title}>
      <div className="toolbar" role="toolbar" aria-label="Actions">
        <label className="check">
          <input
            type="checkbox"
            checked={allChosen}
            disabled={rows.length === 0}
            onChange={() =>
              setSelected(
                allChosen ? new Set() : new Set(rows.map((row) => row.id)),
              )
            }
          />
          <span className="visually-hidden">Select all</span>
        </label>
        {chosen.length > 0 ? (
          <>
            {archive && mailbox && mailbox.id !== archive.id ? (
              <IconButton
                icon="archive"
                label="Archive"
                disabled={busy}
                onClick={() =>
                  void leave(
                    () => store.move(chosenIds, archive.id, mailbox.id),
                    several(chosen.length, 'Archived', 'archived'),
                  )
                }
              />
            ) : null}
            <IconButton
              icon="delete"
              label={inTrash ? 'Delete for good' : 'Delete'}
              disabled={busy}
              onClick={() =>
                void leave(
                  () => store.remove(chosenIds),
                  inTrash
                    ? several(
                        chosen.length,
                        'Deleted for good',
                        'deleted for good',
                      )
                    : several(
                        chosen.length,
                        'Moved to the trash',
                        'moved to the trash',
                      ),
                )
              }
            />
            <IconButton
              icon="unread"
              label={anyUnread ? 'Mark read' : 'Mark unread'}
              disabled={busy}
              onClick={() =>
                void run(() => store.setKeyword(chosenIds, '$seen', anyUnread))
              }
            />
            <MoveTo
              disabled={busy}
              except={mailbox?.id}
              onMove={(to) =>
                void leave(
                  () => store.move(chosenIds, to.id, mailbox?.id),
                  `Moved to ${to.name}`,
                )
              }
            />
            <span className="muted small">
              {several(chosen.length, '1 selected', 'selected')}
            </span>
          </>
        ) : (
          <>
            <IconButton
              icon="refresh"
              label="Refresh"
              disabled={busy}
              onClick={() => void run(() => store.refresh())}
            />
            {emptiable && mailbox && !confirming ? (
              <Button
                size="small"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Empty
              </Button>
            ) : null}
          </>
        )}
        <span className="toolbar-end">
          <h1>{title}</h1>
          {view.total !== null ? (
            <span className="muted small">
              {several(view.total, '1 conversation', 'conversations')}
            </span>
          ) : null}
        </span>
      </div>
      {confirming && mailbox ? (
        <div
          className="notice notice-warning confirm"
          role="alertdialog"
          aria-label={`Empty ${mailbox.name}`}
        >
          <p>
            Delete everything in {mailbox.name} for good? This cannot be undone.
          </p>
          <div className="row">
            <button
              type="button"
              className="button button-small button-danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void leave(async () => {
                  const removed = await store.empty(mailbox.id);
                  say(
                    several(removed, '1 message deleted', 'messages deleted'),
                  );
                }, '');
              }}
            >
              Delete everything
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {!view.isLoaded ? (
        failed ? (
          <div className="pad">
            <p className="muted">This list could not be loaded.</p>
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setFailed(false);
                void act(() => store.open(view)).then((opened) =>
                  setFailed(!opened),
                );
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <p role="status" className="muted pad">
            Loading…
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="muted pad">
          {listKey.search !== undefined
            ? 'Nothing was found.'
            : 'There is nothing here.'}
        </p>
      ) : (
        <ul className="rows">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`row-item${row.unread ? ' unread' : ''}${
                row.email.threadId === threadId ? ' current' : ''
              }`}
            >
              <label className="check">
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => {
                    const next = new Set(selected);
                    if (!next.delete(row.id)) next.add(row.id);
                    setSelected(next);
                  }}
                />
                <span className="visually-hidden">
                  Select{' '}
                  {row.email.subject || 'the conversation without a subject'}
                </span>
              </label>
              <div className="row-main">
                <Link
                  className="row-link"
                  to={`${base}/${row.email.threadId}${suffix}`}
                  aria-current={
                    row.email.threadId === threadId ? 'page' : undefined
                  }
                >
                  <Face name={row.face} email={row.faceEmail} />
                  <span className="row-text">
                    <span className="row-top">
                      <span className="who">
                        {row.who}
                        {row.count > 1 ? (
                          <span
                            className="muted"
                            aria-label={`${row.count} messages`}
                          >
                            {' '}
                            {row.count}
                          </span>
                        ) : null}
                      </span>
                      <span className="marks">
                        {row.unread ? (
                          <span className="visually-hidden">Unread</span>
                        ) : null}
                        {row.flagged ? (
                          <span
                            className="flag"
                            role="img"
                            aria-label="Flagged"
                          >
                            <Icon name="flag" size={14} />
                          </span>
                        ) : null}
                        {row.email.hasAttachment &&
                        !(wide && row.files.length > 0) ? (
                          <span
                            className="clip"
                            role="img"
                            aria-label="Has an attachment"
                          >
                            <Icon name="attach" size={14} />
                          </span>
                        ) : null}
                        <time className="when" dateTime={row.email.receivedAt}>
                          {formatWhen(row.email.receivedAt)}
                        </time>
                      </span>
                    </span>
                    <span className="subject">
                      {row.email.subject || '(no subject)'}
                    </span>
                    <span className="preview muted">{row.email.preview}</span>
                    {row.email.keywords['$draft'] ? (
                      <Tag tone="warning">Draft</Tag>
                    ) : null}
                    {store.held.get(row.email.id) ? (
                      <Tag>
                        To be sent{' '}
                        {formatWhen(
                          store.held.get(row.email.id)?.sendAt as string,
                        )}
                      </Tag>
                    ) : null}
                  </span>
                </Link>
                {wide && row.files.length > 0 ? (
                  <ul className="files" aria-label="Attached">
                    {row.files.slice(0, 3).map((file, index) => (
                      <li key={`${file.blobId} ${index}`}>
                        <button
                          type="button"
                          className="file"
                          title={`${canView(file) ? 'Open' : 'Save'} ${file.name}`}
                          onClick={() =>
                            void act(() => openAttachment(client, file))
                          }
                        >
                          <Icon name="attach" size={14} />
                          <span className="file-name">{file.name}</span>
                        </button>
                      </li>
                    ))}
                    {row.files.length > 3 ? (
                      <li className="muted small">+{row.files.length - 3}</li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
              {wide ? (
                // What is done most, without opening it or selecting it first. Shown under the pointer.
                <span className="row-actions">
                  {archive && mailbox && mailbox.id !== archive.id ? (
                    <IconButton
                      icon="archive"
                      label={`Archive: ${named(row)}`}
                      title="Archive"
                      disabled={busy}
                      onClick={() =>
                        void one(
                          () => store.move(ids(row), archive.id, mailbox.id),
                          'Archived',
                        )
                      }
                    />
                  ) : null}
                  <IconButton
                    icon="delete"
                    label={`${inTrash ? 'Delete for good' : 'Delete'}: ${named(row)}`}
                    title={inTrash ? 'Delete for good' : 'Delete'}
                    disabled={busy}
                    onClick={() =>
                      void one(
                        () => store.remove(ids(row)),
                        inTrash ? 'Deleted for good' : 'Moved to the trash',
                      )
                    }
                  />
                  <IconButton
                    icon="unread"
                    label={`${row.unread ? 'Mark read' : 'Mark unread'}: ${named(row)}`}
                    title={row.unread ? 'Mark read' : 'Mark unread'}
                    disabled={busy}
                    onClick={() =>
                      void one(() =>
                        store.setKeyword(ids(row), '$seen', row.unread),
                      )
                    }
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {view.isLoaded && view.hasMore ? (
        <div className="pad">
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => void run(() => store.more(view))}
          >
            Show more
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** A choice of mailbox to move to. Choosing moves. */
export function MoveTo(props: {
  disabled?: boolean;
  /** The mailbox things are in already. */
  except?: Id | undefined;
  onMove(mailbox: Mailbox): void;
}) {
  const { store } = useMail();
  useSynced(store.mailboxes);
  const mailboxes = store.mailboxes
    .values()
    .filter(
      (mailbox) =>
        mailbox.id !== props.except &&
        mailbox.role !== 'drafts' &&
        mailbox.myRights.mayAddItems,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <select
      className="select-small"
      aria-label="Move to"
      value=""
      disabled={props.disabled || mailboxes.length === 0}
      onChange={(event) => {
        const mailbox = store.mailboxes.get(event.target.value);
        if (mailbox) props.onMove(mailbox);
      }}
    >
      <option value="">Move to…</option>
      {mailboxes.map((mailbox) => (
        <option key={mailbox.id} value={mailbox.id}>
          {mailbox.name}
        </option>
      ))}
    </select>
  );
}
