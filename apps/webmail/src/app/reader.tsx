import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Email, EmailBodyPart, Mailbox } from '@mailless/jmap-core';
import { Button, Icon, IconButton, Tag, type IconName } from '@mailless/ui';
import { formatAddresses, nameOf } from '../lib/addresses';
import {
  canView,
  openAttachment,
  saveMessage,
  showOriginal,
} from '../lib/attachments';
import {
  forwardDraft,
  listedAttachments,
  replyDraft,
  resumeDraft,
} from '../lib/compose';
import { formatFull, formatSize, formatWhen } from '../lib/format';
import {
  hasQuotedHtml,
  hasRemoteImages,
  inlineImageIds,
  messageDocument,
  splitQuotedText,
} from '../lib/html';
import type { Attachment } from '../lib/mail';
import { usePreference } from '../lib/preference';
import { printMessage, type PicturesShown } from '../lib/print';
import { Face } from './face';
import { MoveTo } from './list';
import { TagChip, TagPicker } from './tags';
import { cautions, pictureChoices } from '../lib/senders';
import { InvitationCard } from './invitation';
import { useMail, useServices, useSynced, withUndo } from './services';

/** A picture that came with a message is not shown in it when it is larger than this. */
const MAX_INLINE_BYTES = 3 * 1024 * 1024;

export interface ReaderProps {
  threadId: string;
  /** The mailbox the conversation was opened from, when it was one. */
  mailbox?: Mailbox;
  /** The list to go back to. */
  back: string;
  /** What that list is called: "Inbox". */
  backTo: string;
}

/** The way to take something back, and with it what was done beside it. */
function undoing(
  back: (() => Promise<void>) | null,
  also?: () => Promise<void>,
): (() => Promise<void>) | null {
  if (!also) return back;
  return async () => {
    await back?.();
    await also();
  };
}

export function Reader({ threadId, mailbox, back, backTo }: ReaderProps) {
  const { store, act, say } = useMail();
  const navigate = useNavigate();
  useSynced(store.emails);
  useSynced(store.threads);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [open, setOpen] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState(false);
  /** Whether the messages tucked away in the middle of a long conversation are shown. */
  const [revealed, setRevealed] = useState(false);
  /** Whether the conversation has the page to itself, the list put away until it is gone back to. */
  const [alone, setAlone] = usePreference<boolean>(
    'mailless.mail.reader-alone',
    false,
  );
  const conversation = store.conversation(threadId, mailbox);
  useSynced(store.blocked.made);
  /** Whether the tags of the conversation are being chosen. */
  const [tagging, setTagging] = useState(false);
  useSynced(store.tags.made);

  useEffect(() => {
    let current = true;
    setState('loading');
    void act(() => store.read(threadId)).then((read) => {
      if (!current) return;
      setState(read ? 'ready' : 'failed');
      if (!read) return;
      const emails = store.conversation(threadId, mailbox);
      // Open what has not been read, and the newest whatever it is.
      const unread = emails.filter((email) => !email.keywords['$seen']);
      const last = emails.at(-1);
      setOpen(
        new Set([...unread, ...(last ? [last] : [])].map((email) => email.id)),
      );
      // Reading it is what marks it read. Drafts are not something one reads.
      const seen = unread
        .filter((email) => !email.keywords['$draft'])
        .map((email) => email.id);
      if (seen.length > 0)
        void act(() => store.setKeyword(seen, '$seen', true));
    });
    return () => {
      current = false;
    };
  }, [store, threadId, act]);

  // A message that arrives in the conversation while it is open needs its text too.
  const ids = conversation.map((email) => email.id).join(' ');
  useEffect(() => {
    if (state !== 'ready' || ids === '') return;
    void store.bodies(ids.split(' ')).catch(() => undefined);
  }, [store, state, ids]);

  if (state === 'failed' || (state === 'ready' && conversation.length === 0)) {
    return (
      <section className="reader" aria-label="Conversation">
        <div className="pad">
          <p className="muted">This conversation is no longer here.</p>
          <p>
            <Link to={back}>Back to the list</Link>
          </p>
        </div>
      </section>
    );
  }
  if (state === 'loading' && conversation.length === 0) {
    return (
      <section className="reader" aria-label="Conversation">
        <p role="status" className="muted pad">
          Loading…
        </p>
      </section>
    );
  }

  // In a mailbox, what is done to the conversation is done to its messages that are in it.
  const within = mailbox
    ? conversation.filter((email) => email.mailboxIds[mailbox.id])
    : conversation;
  const scope = (within.length > 0 ? within : conversation).map(
    (email) => email.id,
  );
  const archive = store.mailbox('archive');
  const trash = store.mailbox('trash');
  const inTrash = mailbox !== undefined && mailbox.id === trash?.id;
  const flagged = conversation.some((email) => email.keywords['$flagged']);
  /** In the trash or the junk, where what is being read can be put back from. */
  const putAway = mailbox?.role === 'trash' || mailbox?.role === 'junk';
  const wasIn = putAway
    ? store
        .wasIn(scope)
        .map((each) => each.name)
        .join(' and ')
    : '';
  const subject = conversation[0]?.subject || '(no subject)';

  // A long conversation shows how it began, the message before the last and
  // the last; what lies between and has been read is tucked behind a count.
  const between = conversation
    .slice(1, -2)
    .filter((email) => !(open?.has(email.id) ?? false));
  const tucked = new Set(
    !revealed && open !== null && between.length >= 2
      ? between.map((email) => email.id)
      : [],
  );
  const firstTucked = conversation.findIndex((email) => tucked.has(email.id));

  const leave = async (
    action: () => Promise<unknown>,
    done: string,
    also?: () => Promise<void>,
  ) => {
    setBusy(true);
    const mark = store.mark();
    const worked = await act(action);
    setBusy(false);
    if (!worked) return;
    say(done, withUndo({ act, say }, undoing(store.undoSince(mark), also)));
    void navigate(back);
  };

  // Out of the junk by hand says its sender is wanted: they are blocked no more.
  const unblocked =
    mailbox?.role === 'junk'
      ? [
          ...new Set(
            within.flatMap((email) => {
              const address = email.from?.[0]?.email.toLowerCase();
              return address &&
                store.blocked.blocking(address)?.address === address
                ? [address]
                : [];
            }),
          ),
        ]
      : [];

  return (
    <section
      className={`reader${alone ? ' reader-alone' : ''}`}
      aria-label="Conversation"
    >
      <div className="toolbar" role="toolbar" aria-label="Conversation actions">
        <Link
          className="icon-button back"
          to={back}
          aria-label={`Back to ${backTo}`}
          title={`Back to ${backTo}`}
        >
          <Icon name="back" />
        </Link>
        {archive && mailbox && mailbox.id !== archive.id ? (
          <IconButton
            icon="archive"
            label="Archive"
            disabled={busy}
            onClick={() =>
              void leave(
                () => store.move(scope, archive.id, mailbox.id),
                'Archived',
              )
            }
          />
        ) : null}
        <IconButton
          icon="delete"
          label={inTrash ? 'Delete permanently' : 'Delete'}
          disabled={busy}
          onClick={() =>
            void leave(
              () => store.remove(scope),
              inTrash ? 'Permanently deleted' : 'Moved to the trash',
            )
          }
        />
        {putAway && wasIn !== '' ? (
          <Button
            size="small"
            icon="inbox"
            disabled={busy}
            onClick={() =>
              void leave(
                async () => {
                  await store.restore(scope);
                  for (const address of unblocked) {
                    await store.blocked.unblock(address);
                  }
                },
                unblocked.length > 0
                  ? `Moved back to ${wasIn}. ${unblocked.join(' and ')} is no longer blocked.`
                  : `Moved back to ${wasIn}`,
                unblocked.length > 0
                  ? async () => {
                      for (const address of unblocked) {
                        await store.blocked.block(address);
                      }
                    }
                  : undefined,
              )
            }
          >
            Move back to {wasIn}
          </Button>
        ) : null}
        <span className="toolbar-gap" />
        <IconButton
          icon="unread"
          label="Mark unread"
          disabled={busy}
          onClick={() =>
            void leave(
              () => store.setKeyword(scope, '$seen', false),
              'Marked unread',
            )
          }
        />
        <IconButton
          icon="flag"
          label={flagged ? 'Remove the star' : 'Star'}
          pressed={flagged}
          disabled={busy}
          onClick={() =>
            void act(() =>
              flagged
                ? store.setKeyword(
                    conversation.map((email) => email.id),
                    '$flagged',
                    false,
                  )
                : store.setKeyword(scope.slice(-1), '$flagged', true),
            )
          }
        />
        <MoveTo
          disabled={busy}
          except={mailbox?.id}
          onMove={(to) =>
            void leave(
              () => store.move(scope, to.id, mailbox?.id),
              `Moved to ${to.name}`,
            )
          }
        />
        <span className="more">
          <IconButton
            icon="tag"
            label="Tags"
            pressed={tagging}
            disabled={busy}
            onClick={() => setTagging(!tagging)}
          />
          {tagging ? (
            <TagPicker
              emails={conversation}
              onClose={() => setTagging(false)}
            />
          ) : null}
        </span>
        <span className="toolbar-end reader-size">
          <IconButton
            icon={alone ? 'shrink' : 'expand'}
            label={alone ? 'Show the list beside it' : 'Read on the whole page'}
            pressed={alone}
            onClick={() => setAlone(!alone)}
          />
        </span>
      </div>
      <h2 className="reader-subject">
        {subject}
        {mailbox ? <Tag>{mailbox.name}</Tag> : null}
        {store.tags.on(conversation).map((tag) => (
          <TagChip
            key={tag.id}
            tag={tag}
            onRemove={() =>
              void act(() =>
                store.setKeyword(
                  conversation.map((email) => email.id),
                  tag.keyword,
                  false,
                ),
              )
            }
          />
        ))}
      </h2>
      <ol className="messages">
        {conversation.map((email, index) =>
          tucked.has(email.id) ? (
            index === firstTucked ? (
              <li key="tucked" className="tucked">
                <button
                  type="button"
                  className="tucked-count"
                  aria-label={`Show ${tucked.size} earlier messages`}
                  title={`Show ${tucked.size} earlier messages`}
                  onClick={() => setRevealed(true)}
                >
                  {tucked.size}
                </button>
              </li>
            ) : null
          ) : (
            <li key={email.id}>
              <Message
                email={email}
                open={open?.has(email.id) ?? false}
                fromHere={conversation.slice(index).map((each) => each.id)}
                alone={conversation.length === 1}
                leave={leave}
                onToggle={() => {
                  const next = new Set(open ?? []);
                  if (!next.delete(email.id)) next.add(email.id);
                  setOpen(next);
                }}
              />
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

export interface Choice {
  label: string;
  icon: IconName;
  act(): void;
}

/** A button that opens a short list of things to do. Null in the list draws a line. */
export function More(props: { label: string; choices: Array<Choice | null> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <span className="more" ref={box}>
      <IconButton
        icon="more"
        label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div className="more-menu" role="menu" aria-label={props.label}>
          {props.choices.map((choice, index) =>
            choice === null ? (
              <hr key={index} />
            ) : (
              <button
                key={choice.label}
                type="button"
                role="menuitem"
                className="more-choice"
                onClick={() => {
                  setOpen(false);
                  choice.act();
                }}
              >
                <Icon name={choice.icon} size={18} />
                {choice.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </span>
  );
}

interface MessageProps {
  email: Email;
  open: boolean;
  onToggle(): void;
  /** This message and those after it in the conversation. */
  fromHere: readonly string[];
  /**
   * Does something after which the conversation is left, and says it was
   * done. `also` takes back what was done beside it, when that is undone.
   */
  leave(
    action: () => Promise<unknown>,
    done: string,
    also?: () => Promise<void>,
  ): Promise<void>;
  /** Whether it is the only message of the conversation: without it, nothing is left to read. */
  alone: boolean;
}

function Message(props: MessageProps) {
  const { email, open } = props;
  const { client, theme } = useServices();
  const { store, compose, act, say, unsend } = useMail();
  // On a dark page a message is dark too, unless asked for as it was written.
  const [page, setPage] = useState(() => theme?.shown ?? 'light');
  useEffect(() => {
    if (!theme) return;
    setPage(theme.shown);
    return theme.subscribe(() => setPage(theme.shown));
  }, [theme]);
  const [original, setOriginal] = useState(false);
  const dark = page === 'dark' && !original;
  const styled = (email.htmlBody ?? []).some(
    (part) => part.type === 'text/html',
  );
  const navigate = useNavigate();
  useSynced(store.identities);
  useSynced(store.held);
  const held = store.held.get(props.email.id);
  const identities = store.identities.values();
  const sender = email.from?.[0];
  const who = sender ? nameOf(sender) : 'an unknown sender';
  const draft = email.keywords['$draft'] === true;
  const flagged = email.keywords['$flagged'] === true;
  const loaded = email.bodyValues !== undefined;
  const canSend = identities.length > 0;
  const several = (email.to?.length ?? 0) + (email.cc?.length ?? 0) > 1;
  const junk = store.mailbox('junk');
  const trash = store.mailbox('trash');
  const inTrash = trash !== undefined && email.mailboxIds[trash.id] === true;
  /** Which pictures each part of the message is showing, for printing the same. */
  const shown = useRef(new Map<string, PicturesShown>());

  /** Takes this one message away. The rest of the conversation stays open. */
  const away = (
    action: () => Promise<unknown>,
    done: string,
    also?: () => Promise<void>,
  ) => {
    if (props.alone) return void props.leave(action, done, also);
    const mark = store.mark();
    void act(action).then((worked) => {
      if (worked) {
        say(done, withUndo({ act, say }, undoing(store.undoSince(mark), also)));
      }
    });
  };
  useSynced(store.blocked.made);
  const own =
    sender !== undefined &&
    identities.some(
      (identity) => identity.email.toLowerCase() === sender.email.toLowerCase(),
    );
  const blocked = sender ? store.blocked.blocking(sender.email) : undefined;
  const blockable = store.blocked.available && sender !== undefined && !own;
  // Reporting junk remembers who sent it. Not someone in the address book:
  // one slip would hide everything a friend writes.
  const remembers =
    blockable && !blocked && !store.contacts.cardFor(sender.email);
  const choices: Array<Choice | null | false> = [
    canSend && {
      label: 'Reply',
      icon: 'reply',
      act: () => compose(replyDraft(email, identities, false)),
    },
    canSend &&
      several && {
        label: 'Reply to all',
        icon: 'reply-all',
        act: () => compose(replyDraft(email, identities, true)),
      },
    canSend && {
      label: 'Forward',
      icon: 'forward',
      act: () => compose(forwardDraft(email, identities)),
    },
    canSend && null,
    {
      label: inTrash
        ? 'Delete this message permanently'
        : 'Delete this message',
      icon: 'delete',
      act: () =>
        away(
          () => store.remove([email.id]),
          inTrash ? 'Permanently deleted' : 'Moved to the trash',
        ),
    },
    {
      label: 'Mark unread from here',
      icon: 'unread',
      act: () =>
        void props.leave(
          () => store.setKeyword(props.fromHere, '$seen', false),
          'Marked unread',
        ),
    },
    junk !== undefined &&
      !email.mailboxIds[junk.id] && {
        label: 'Report as junk',
        icon: 'junk',
        act: () =>
          away(
            async () => {
              await store.move([email.id], junk.id);
              if (remembers) await store.blocked.block(sender.email);
            },
            remembers
              ? `Moved to Junk. More from ${sender.email} will go there too.`
              : 'Moved to Junk',
            remembers ? () => store.blocked.unblock(sender.email) : undefined,
          ),
      },
    junk !== undefined &&
      !email.mailboxIds[junk.id] && {
        label: 'Report phishing',
        icon: 'junk',
        act: () =>
          away(
            // Marked for what it is, as mail programs agree to mark it, then put with the junk.
            () =>
              store
                .setKeyword([email.id], '$phishing', true)
                .then(() => store.move([email.id], junk.id)),
            'Reported as phishing, and moved to Junk',
          ),
      },
    blockable &&
      (blocked
        ? {
            label: `Stop blocking ${blocked.address}`,
            icon: 'junk' as const,
            act: () =>
              void act(() => store.blocked.unblock(blocked.address)).then(
                (worked) => {
                  if (worked) say(`${blocked.address} is no longer blocked`);
                },
              ),
          }
        : {
            label: `Block ${sender.email}`,
            icon: 'junk' as const,
            act: () =>
              void act(() => store.blocked.block(sender.email)).then(
                (worked) => {
                  if (!worked) return;
                  say(
                    `More from ${sender.email} will go to Junk`,
                    withUndo({ act, say }, () =>
                      store.blocked.unblock(sender.email),
                    ),
                  );
                },
              ),
          }),
    sender !== undefined && {
      label: `Add ${who} to contacts`,
      icon: 'contacts',
      act: () =>
        void navigate(
          `/contacts/new?${new URLSearchParams({
            name: sender.name?.trim() ?? '',
            email: sender.email,
          }).toString()}`,
        ),
    },
    null,
    {
      label: 'Print',
      icon: 'file',
      act: () => {
        // The pictures on the screen, of whichever of its parts show any.
        const parts = [...shown.current.values()];
        printMessage(email, {
          images: parts.some((part) => part.images),
          inline: Object.assign({}, ...parts.map((part) => part.inline)),
        });
      },
    },
    {
      label: 'Download message',
      icon: 'attach',
      act: () => void act(() => saveMessage(client, email)),
    },
    {
      label: 'Show original',
      icon: 'mail',
      act: () => void act(() => showOriginal(client, email)),
    },
  ];

  return (
    <article
      className={`message${open ? ' open' : ''}`}
      aria-label={`Message from ${who}`}
    >
      <div className="message-top">
        <button
          type="button"
          className="message-head"
          aria-expanded={open}
          onClick={props.onToggle}
        >
          <Face
            name={sender ? nameOf(sender) : '?'}
            email={sender?.email}
            {...(open ? { size: 'large' as const } : {})}
          />
          <span className="message-from">
            <strong>{sender ? nameOf(sender) : '(unknown sender)'}</strong>
            {draft ? <Tag tone="warning">Draft</Tag> : null}
            {open && sender?.name ? (
              <span className="muted small"> {sender.email}</span>
            ) : null}
          </span>
          <time
            className="when muted small"
            dateTime={email.receivedAt}
            title={formatFull(email.receivedAt)}
          >
            {open ? formatFull(email.receivedAt) : formatWhen(email.receivedAt)}
          </time>
          {open ? null : <span className="preview muted">{email.preview}</span>}
        </button>
        {open && !draft ? (
          <span className="message-tools">
            {page === 'dark' && styled ? (
              <IconButton
                icon={original ? 'moon' : 'sun'}
                label={
                  original
                    ? 'Show this message in dark colours'
                    : 'Show this message in its own colours'
                }
                onClick={() => setOriginal(!original)}
              />
            ) : null}
            <IconButton
              icon="flag"
              label={
                flagged
                  ? 'Remove the star from this message'
                  : 'Star this message'
              }
              pressed={flagged}
              onClick={() =>
                void act(() =>
                  store.setKeyword([email.id], '$flagged', !flagged),
                )
              }
            />
            <IconButton
              icon="reply"
              label={`Reply to ${who}`}
              disabled={!canSend || !loaded}
              onClick={() => compose(replyDraft(email, identities, false))}
            />
            {loaded ? (
              <More
                label="More for this message"
                choices={choices.filter((choice) => choice !== false)}
              />
            ) : null}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="message-body">
          {held ? (
            <p className="notice small held-notice">
              Not sent yet: it goes {formatFull(held.sendAt)}.{' '}
              <button
                type="button"
                className="button button-small"
                onClick={() => void unsend(held)}
              >
                Do not send it
              </button>
            </p>
          ) : null}
          <p className="recipients muted small">
            To: {formatAddresses(email.to) || '(nobody)'}
            {email.cc?.length ? <> · Cc: {formatAddresses(email.cc)}</> : null}
            {email.bcc?.length ? (
              <> · Bcc: {formatAddresses(email.bcc)}</>
            ) : null}
          </p>
          <Cautions email={email} />
          {loaded ? (
            <>
              <InvitationCard email={email} />
              <Body
                email={email}
                dark={dark}
                onShown={(part, pictures) => shown.current.set(part, pictures)}
              />
              <Attachments attachments={listedAttachments(email)} />
              <div className="row message-actions">
                {draft ? (
                  <Button
                    variant="primary"
                    className="button-pill"
                    icon="write"
                    disabled={!canSend}
                    onClick={() => compose(resumeDraft(email, identities))}
                  >
                    Go on writing
                  </Button>
                ) : (
                  <>
                    <Button
                      className="button-pill"
                      icon="reply"
                      disabled={!canSend}
                      onClick={() =>
                        compose(replyDraft(email, identities, false))
                      }
                    >
                      Reply
                    </Button>
                    {several ? (
                      <Button
                        className="button-pill"
                        icon="reply-all"
                        disabled={!canSend}
                        onClick={() =>
                          compose(replyDraft(email, identities, true))
                        }
                      >
                        Reply to all
                      </Button>
                    ) : null}
                    <Button
                      className="button-pill"
                      icon="forward"
                      disabled={!canSend}
                      onClick={() => compose(forwardDraft(email, identities))}
                    >
                      Forward
                    </Button>
                  </>
                )}
              </div>
            </>
          ) : (
            <p role="status" className="muted">
              Loading…
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

/** What a message says: each part of its body in turn, as it was written. */
function Body(props: {
  email: Email;
  dark: boolean;
  onShown(part: string, pictures: PicturesShown): void;
}) {
  const { email, dark, onShown } = props;
  const parts = (email.htmlBody ?? []).filter(
    (part) => part.type === 'text/html' || part.type === 'text/plain',
  );
  const values = email.bodyValues ?? {};
  if (parts.length === 0) {
    return <p className="muted">This message has no text.</p>;
  }
  return (
    <>
      {parts.map((part, index) => {
        const value = part.partId ? values[part.partId] : undefined;
        const text = value?.value ?? '';
        return (
          <div key={part.partId ?? index} className="part">
            {part.type === 'text/html' ? (
              <HtmlPart
                html={text}
                email={email}
                dark={dark}
                onShown={(pictures) =>
                  onShown(part.partId ?? String(index), pictures)
                }
              />
            ) : (
              <PlainPart text={text} />
            )}
            {value?.isTruncated ? (
              <p className="muted small">
                This message is very long; only its beginning is shown.
              </p>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

const URL_IN_TEXT = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Shows or folds away what a message quotes of earlier ones. */
function QuoteSwitch(props: { shown: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className="quote-switch"
      aria-expanded={props.shown}
      aria-label={props.shown ? 'Hide quoted text' : 'Show quoted text'}
      title={props.shown ? 'Hide quoted text' : 'Show quoted text'}
      onClick={props.onToggle}
    >
      •••
    </button>
  );
}

function linked(text: string) {
  return text.split(URL_IN_TEXT).map((piece, index) =>
    index % 2 === 1 ? (
      <a key={index} href={piece} target="_blank" rel="noopener noreferrer">
        {piece}
      </a>
    ) : (
      piece
    ),
  );
}

function PlainPart({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  const { body, quoted } = useMemo(() => splitQuotedText(text), [text]);
  return (
    <>
      <div className="plain">{linked(body)}</div>
      {quoted !== '' ? (
        <>
          <QuoteSwitch shown={shown} onToggle={() => setShown(!shown)} />
          {shown ? <div className="plain quoted">{linked(quoted)}</div> : null}
        </>
      ) : null}
    </>
  );
}

function toDataUrl(bytes: Uint8Array, type: string): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** The pictures that came with a message and that its HTML shows, by content id. */
function useInlineImages(email: Email, html: string): Record<string, string> {
  const { client } = useServices();
  const [images, setImages] = useState<Record<string, string>>({});
  const wanted = useMemo(() => {
    const ids = new Set(inlineImageIds(html));
    if (ids.size === 0) return [];
    const found: EmailBodyPart[] = [];
    const visit = (parts: readonly EmailBodyPart[] | null | undefined) => {
      for (const part of parts ?? []) {
        const id = part.cid?.replace(/^<|>$/g, '');
        if (
          id &&
          ids.has(id) &&
          part.blobId &&
          part.type.startsWith('image/') &&
          part.size <= MAX_INLINE_BYTES &&
          !found.some((each) => each.cid === part.cid)
        ) {
          found.push(part);
        }
      }
    };
    visit(email.attachments);
    visit(email.htmlBody);
    return found;
  }, [email.attachments, email.htmlBody, html]);

  useEffect(() => {
    if (wanted.length === 0) return;
    let current = true;
    void Promise.all(
      wanted.map(async (part) => {
        try {
          const bytes = await client.download(part.blobId as string, {
            type: part.type,
            name: part.name ?? 'image',
          });
          return [
            (part.cid as string).replace(/^<|>$/g, ''),
            toDataUrl(bytes, part.type),
          ] as const;
        } catch {
          // A picture that cannot be had is left out; the message is still read.
          return null;
        }
      }),
    ).then((loaded) => {
      if (!current) return;
      setImages(Object.fromEntries(loaded.filter((entry) => entry !== null)));
    });
    return () => {
      current = false;
    };
  }, [client, wanted]);
  return images;
}

/** What there is to know about who a message is from, before believing it. */
function Cautions({ email }: { email: Email }) {
  const { store, act, say } = useMail();
  useSynced(store.identities);
  useSynced(store.contacts.cards);
  useSynced(store.blocked.made);
  const sender = email.from?.[0];
  const own = store.identities.values();
  const found = cautions(email, {
    own,
    others: store.contacts.otherAddresses(own),
    cards: store.contacts.cards.values(),
  });
  const blocked = sender ? store.blocked.blocking(sender.email) : undefined;
  // Worth asking of what arrived from someone who is not in the address book.
  const stranger =
    sender !== undefined &&
    !email.keywords['$draft'] &&
    !own.some(
      (each) => each.email.toLowerCase() === sender.email.toLowerCase(),
    ) &&
    !store.contacts.cardFor(sender.email);
  const [first, setFirst] = useState(false);
  useEffect(() => {
    setFirst(false);
    if (!stranger) return undefined;
    let current = true;
    void store.firstTimes.of(email).then((is) => {
      if (current) setFirst(is);
    });
    return () => {
      current = false;
    };
    // The message is what is asked about: another one is another question.
  }, [store, email.id, stranger]);
  if (!sender) return null;

  return (
    <>
      {found.map((caution) =>
        caution.kind === 'forged' ? (
          <p key="forged" className="notice notice-error caution" role="note">
            <strong>This message may be forged.</strong> It did not pass the
            check that it comes from {caution.domain}, or it was reported as
            phishing. Be careful with its links and with what is attached.
          </p>
        ) : caution.kind === 'unverified' ? (
          <p
            key="unverified"
            className="notice notice-warning caution"
            role="note"
          >
            <strong>Nothing confirms where this comes from.</strong> It says{' '}
            {caution.domain}, and neither that domain nor the server that sent
            it vouches for it. Be careful if it asks for something.
          </p>
        ) : (
          <p
            key="namesake"
            className="notice notice-warning caution"
            role="note"
          >
            <strong>
              {caution.own
                ? 'This bears your name, and is not from an address you write from here.'
                : `${caution.name} is in your contacts with another address.`}
            </strong>{' '}
            This message comes from {sender.email}.
            {caution.own ? (
              <>
                {' '}
                <button
                  type="button"
                  className="button button-small"
                  onClick={() =>
                    void act(() =>
                      store.contacts.setOtherAddresses(own, [
                        ...store.contacts.otherAddresses(own),
                        sender.email,
                      ]),
                    ).then((worked) => {
                      if (worked) {
                        say(`${sender.email} is one of your addresses`);
                      }
                    })
                  }
                >
                  It is mine
                </button>
              </>
            ) : null}
          </p>
        ),
      )}
      {blocked ? (
        <p className="notice caution small" role="note">
          You blocked {blocked.address}: what it sends goes to Junk.{' '}
          <button
            type="button"
            className="button button-small"
            onClick={() =>
              void act(() => store.blocked.unblock(blocked.address)).then(
                (worked) => {
                  if (worked) say(`${blocked.address} is no longer blocked`);
                },
              )
            }
          >
            Stop blocking
          </button>
        </p>
      ) : first ? (
        <p className="notice caution small" role="note">
          This is the first message you have from {sender.email}.
        </p>
      ) : null}
    </>
  );
}

function HtmlPart(props: {
  html: string;
  email: Email;
  /** Whether it is shown light on dark, to go with a dark page. */
  dark: boolean;
  onShown(pictures: PicturesShown): void;
}) {
  const { html, email, dark } = props;
  const { store, act, say } = useMail();
  useSynced(store.pictures.made);
  const [asked, setAsked] = useState(false);
  // Those the person said may always know the message was opened, where it is theirs for certain.
  const always = store.pictures.available ? pictureChoices(email) : [];
  const images =
    asked || always.some((each) => store.pictures.showing(each) !== undefined);
  const inline = useInlineImages(email, html);
  const said = useRef(props.onShown);
  said.current = props.onShown;
  useEffect(() => {
    said.current({ images, inline });
  }, [images, inline]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const remote = useMemo(() => hasRemoteImages(html), [html]);
  const [quoted, setQuoted] = useState(false);
  const quotes = useMemo(() => hasQuotedHtml(html), [html]);
  const page = useMemo(
    () => messageDocument(html, { images, inline, quoted, dark }),
    [html, images, inline, quoted, dark],
  );

  // The frame is as tall as what is in it, so the page scrolls and the message does not.
  const watching = useRef<ResizeObserver | null>(null);
  const measure = () => {
    const root = frame.current?.contentDocument?.documentElement;
    if (root) setHeight(Math.max(root.scrollHeight, 40));
  };
  const onLoad = () => {
    measure();
    watching.current?.disconnect();
    const body = frame.current?.contentDocument?.body;
    if (!body || typeof ResizeObserver === 'undefined') return;
    // Pictures arrive after the page does, and make it taller.
    watching.current = new ResizeObserver(measure);
    watching.current.observe(body);
  };
  useEffect(() => () => watching.current?.disconnect(), []);

  return (
    <>
      {remote && !images ? (
        <p className="notice images-notice small">
          Pictures kept on other sites are not shown: loading them tells the
          sender you opened this.{' '}
          <button
            type="button"
            className="button button-small"
            onClick={() => setAsked(true)}
          >
            Show pictures
          </button>
          {always.map((each) => (
            <button
              key={each}
              type="button"
              className="button button-small"
              onClick={() =>
                void act(() => store.pictures.always(each)).then((worked) => {
                  if (worked) {
                    say(
                      `Pictures from ${each} will always be shown`,
                      withUndo({ act, say }, () => store.pictures.ask(each)),
                    );
                  }
                })
              }
            >
              Always from {each}
            </button>
          ))}
        </p>
      ) : null}
      <iframe
        ref={frame}
        className={`message-frame${dark ? ' message-frame-dark' : ''}`}
        title="Message"
        // No script runs in the frame. Links open beside the mail, as pages of their own.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={page}
        height={height}
        onLoad={onLoad}
      />
      {quotes ? (
        <QuoteSwitch shown={quoted} onToggle={() => setQuoted(!quoted)} />
      ) : null}
    </>
  );
}

function Attachments({ attachments }: { attachments: Attachment[] }) {
  const { client } = useServices();
  const { act } = useMail();
  const [busy, setBusy] = useState<string | null>(null);
  if (attachments.length === 0) return null;

  const open = async (attachment: Attachment) => {
    setBusy(attachment.blobId);
    await act(() => openAttachment(client, attachment));
    setBusy(null);
  };

  return (
    <ul className="attachments" aria-label="Attachments">
      {attachments.map((attachment, index) => (
        <li key={`${attachment.blobId}-${index}`}>
          <button
            type="button"
            className="button button-small attachment"
            disabled={busy !== null}
            title={canView(attachment) ? 'Open' : 'Save'}
            onClick={() => void open(attachment)}
          >
            <span className="attachment-name">{attachment.name}</span>
            <span className="muted">
              {busy === attachment.blobId
                ? 'Opening…'
                : formatSize(attachment.size)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
