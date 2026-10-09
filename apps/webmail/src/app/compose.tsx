import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { EmailAddress } from '@mailless/jmap-core';
import { JmapRequestError } from '@mailless/jmap-client';
import { Avatar, Icon, IconButton } from '@mailless/ui';
import { nameOf, parseAddresses } from '../lib/addresses';
import {
  isPicture,
  laterChoices,
  mentionsAttachment,
  plainOf,
  signatureBlock,
} from '../lib/compose';
import { formatFull, formatSize } from '../lib/format';
import { messageDocument } from '../lib/html';
import {
  MailError,
  type Attachment,
  type Draft,
  type Picture,
} from '../lib/mail';
import type { Person } from '../lib/people';
import { usePreference } from '../lib/preference';
import { UNDO_SECONDS } from '../lib/undo';
import { Editor } from './editor';
import type { PictureSource } from './pictures';
import { useMail, useServices, useSynced } from './services';

export interface ComposeProps {
  draft: Draft;
  /**
   * Whether it is the one being written, of those that are open. The
   * others wait, down to their titles.
   */
  front: boolean;
  /** Asks to be the one being written. */
  onFront(): void;
  onClose(): void;
}

/** How long after the last change a message being written is kept, in milliseconds. */
const KEEP_AFTER = 2500;

/** People a message is for, and what is being typed after the last of them. */
interface People {
  list: EmailAddress[];
  typing: string;
}

const people = (list: EmailAddress[]): People => ({ list, typing: '' });

/** What is typed, read as addresses. Null when some of it is not one. */
function typed(text: string): EmailAddress[] | null {
  if (text.trim() === '') return [];
  return parseAddresses(text).addresses ?? null;
}

interface RecipientsProps {
  /** What its field is known by on the page, which no other field is. */
  id: string;
  label: string;
  value: People;
  /** Who what is typed might be the start of. */
  suggest(typed: string): Person[];
  input?: RefObject<HTMLInputElement | null>;
  onChange(value: People): void;
  children?: ReactNode;
}

/** A line of who a message is for: each a chip, and a place to type the next. */
function Recipients(props: RecipientsProps) {
  const { id, label, value, input, onChange, suggest, children } = props;
  /** Which of the people suggested is marked, and whether they are shown at all. */
  const [marked, setMarked] = useState(0);
  const [hidden, setHidden] = useState(false);
  const suggested = hidden ? [] : suggest(value.typing);
  const at = Math.min(marked, suggested.length - 1);

  /** Turns what is typed into people, when all of it is addresses. */
  const settle = (text: string): boolean => {
    const added = typed(text);
    if (added === null) return false;
    if (added.length > 0 || text !== value.typing) {
      onChange({ list: [...value.list, ...added], typing: '' });
    }
    return true;
  };
  const take = (person: Person) => {
    onChange({ list: [...value.list, person], typing: '' });
    setMarked(0);
  };
  const type = (text: string) => {
    setHidden(false);
    setMarked(0);
    // A comma ends an address: what is before the last one becomes people.
    const end = Math.max(text.lastIndexOf(','), text.lastIndexOf(';'));
    const added = end < 0 ? null : typed(text.slice(0, end));
    if (added === null) onChange({ ...value, typing: text.trimStart() });
    else {
      onChange({
        list: [...value.list, ...added],
        typing: text.slice(end + 1).trimStart(),
      });
    }
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    const person = suggested[at];
    if (person && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setMarked((at + step + suggested.length) % suggested.length);
    } else if (person && event.key === 'Escape') {
      event.stopPropagation();
      setHidden(true);
    } else if (
      person &&
      (event.key === 'Enter' || event.key === 'Tab') &&
      // An address typed out in full is the one meant, whoever else begins like it.
      !(typed(value.typing)?.length === 1)
    ) {
      event.preventDefault();
      take(person);
    } else if (event.key === 'Enter' && value.typing.trim() !== '') {
      event.preventDefault();
      settle(value.typing);
    } else if (event.key === 'Backspace' && value.typing === '') {
      onChange({ ...value, list: value.list.slice(0, -1) });
    }
  };
  return (
    <div className="compose-row">
      <label htmlFor={id}>{label}</label>
      <ul className="chips" aria-label={`${label}: people`}>
        {value.list.map((person, index) => (
          <li key={`${person.email}-${index}`} className="chip">
            <Avatar name={nameOf(person)} size="small" />
            <span className="chip-name" title={person.email}>
              {nameOf(person)}
            </span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${nameOf(person)}`}
              onClick={() =>
                onChange({
                  ...value,
                  list: value.list.filter((_, each) => each !== index),
                })
              }
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        <li className="chip-input">
          <input
            id={id}
            ref={input}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggested.length > 0}
            aria-controls={`${id}-people`}
            aria-activedescendant={
              suggested.length > 0 ? `${id}-person-${at}` : undefined
            }
            value={value.typing}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => type(event.target.value)}
            onKeyDown={key}
            onBlur={() => {
              settle(value.typing);
              setHidden(true);
            }}
          />
        </li>
      </ul>
      {children}
      {suggested.length > 0 ? (
        <ul
          className="suggestions"
          id={`${id}-people`}
          role="listbox"
          aria-label={`${label}: suggestions`}
        >
          {suggested.map((person, index) => (
            <li
              key={person.email}
              id={`${id}-person-${index}`}
              role="option"
              aria-selected={index === at}
              className="suggestion"
              // Pressed with the cursor still in the field, which leaving would settle.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => take(person)}
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
    </div>
  );
}

/** A date as a `datetime-local` field holds it: in this place's time, to the minute. */
function fieldTime(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** Beside Send: the times it might go at instead of now. */
function SendLater(props: {
  disabled: boolean;
  /** The longest the server holds a message, in seconds. */
  most: number;
  onPick(at: Date): void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const pick = (at: Date) => {
    setOpen(false);
    props.onPick(at);
  };
  const schedule = () => {
    const at = new Date(picked);
    const ahead = at.getTime() - Date.now();
    if (picked === '' || Number.isNaN(ahead)) {
      setProblem('Say when to send it.');
    } else if (ahead <= 0) setProblem('That time has passed.');
    else if (ahead > props.most * 1000) {
      setProblem(
        `A message can wait ${Math.floor(props.most / 86_400)} days at most.`,
      );
    } else pick(at);
  };
  const now = new Date();
  return (
    <span className="send-later" ref={box}>
      <button
        type="button"
        className="button button-primary send-later-button"
        aria-label="Send later"
        title="Send later"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => {
          setOpen(!open);
          setProblem(null);
        }}
      >
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div
          className="more-menu send-later-menu"
          role="menu"
          aria-label="Send later"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
            // Enter in here chooses a time, and does not send the message now.
            if (event.key === 'Enter') event.stopPropagation();
          }}
        >
          {laterChoices(now).map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="menuitem"
              className="more-choice"
              onClick={() => pick(choice.at)}
            >
              <span className="send-later-name">{choice.label}</span>
              <span className="muted small">
                {formatFull(choice.at.toISOString())}
              </span>
            </button>
          ))}
          <hr />
          <div className="send-later-own">
            <input
              type="datetime-local"
              aria-label="Another time"
              aria-invalid={problem !== null}
              min={fieldTime(now)}
              value={picked}
              onChange={(event) => {
                setPicked(event.target.value);
                setProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                schedule();
              }}
            />
            <button
              type="button"
              className="button button-small"
              onClick={schedule}
            >
              Send then
            </button>
          </div>
          {problem ? (
            <p className="small send-later-problem" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

type View = 'docked' | 'minimised' | 'full';

/** A message being written: who to, what about, what it says, what goes with it. */
export function Compose({ draft, front, onFront, onClose }: ComposeProps) {
  // Several may be open at once: what each field is known by is its own.
  const uid = useId();
  const { client } = useServices();
  const { store, act, say, unsend } = useMail();
  useSynced(store.identities);
  const identities = store.identities.values();

  const [view, setView] = useState<View>('docked');
  /** Behind another, it is down to its title whatever size it was left at. */
  const size: View = front ? view : 'minimised';
  const [tools, setTools] = usePreference<boolean>(
    'mailless.mail.compose-tools',
    true,
  );
  const [identityId, setIdentityId] = useState(draft.identityId);
  const [to, setTo] = useState(() => people(draft.to));
  const [cc, setCc] = useState(() => people(draft.cc));
  const [bcc, setBcc] = useState(() => people(draft.bcc));
  const [others, setOthers] = useState(draft.cc.length + draft.bcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [quote, setQuote] = useState(draft.quote);
  const [quoteShown, setQuoteShown] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>(
    draft.attachments,
  );
  const [attaching, setAttaching] = useState<string[]>([]);
  /** The pictures among the words, and where this page shows each from. */
  const [pictures, setPictures] = useState<Picture[]>(draft.pictures ?? []);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'sending' | 'closing' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<'discard' | 'attachment' | null>(null);
  /** When it is to be sent, while it is asked whether to send it as it is. */
  const wanted = useRef<Date | undefined>(undefined);
  /** For how many seconds a message just sent can be taken back. Nought is not at all. */
  const [undoSeconds] = usePreference<number>(UNDO_SECONDS, 10);
  const [keptAt, setKeptAt] = useState<Date | null>(null);
  /** How many changes have been made, and how many of them are kept. */
  const [changes, setChanges] = useState(0);
  const keptChanges = useRef(0);
  /** What the editor holds. It changes with every letter, and nothing is drawn from it. */
  const words = useRef(draft.html);
  /** The copy kept on the server, which the next one kept or sent replaces. */
  const kept = useRef(draft.replaces);
  /** Where each file and picture went when the message was last kept, by where it was before. */
  const moved = useRef(new Map<string, string>());
  /** Keeping and sending take their turn: each replaces the copy the last one left. */
  const turn = useRef<Promise<unknown>>(Promise.resolve());
  const first = useRef<HTMLInputElement>(null);
  /** Where in the bar the editor puts its own buttons. */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const files = useRef<HTMLInputElement>(null);

  // An answer starts where the words go; a new message with who it is for.
  // Who there is to write to is found out when a message is first written.
  const [, setPeopleKnown] = useState(false);
  useEffect(() => {
    let current = true;
    void store.people.start(store.mailbox('sent')?.id).then(() => {
      if (current) setPeopleKnown(true);
    });
    return () => {
      current = false;
    };
  }, [store]);
  const suggest = (text: string) =>
    store.people.find(text, {
      // Not those it is for already, nor oneself.
      without: [
        ...[...to.list, ...cc.list, ...bcc.list].map((each) => each.email),
        ...identities.map((each) => each.email),
      ],
      // Whoever wrote the mail that has been looked at here.
      others: store.emails.values().flatMap((email) => email.from ?? []),
    });

  const answering = draft.to.length > 0;
  useEffect(() => {
    if (!answering) first.current?.focus();
  }, [answering]);

  const changed = () => {
    setChanges((count) => count + 1);
    setProblem(null);
    setAsking(null);
  };
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      changed();
    };

  /**
   * What is in the form as a message. Null with the problem shown when
   * something typed is not an address; kept quietly, it is left out instead.
   */
  const written = (quietly: boolean): Draft | null => {
    const lines: Array<[string, People]> = [
      ['To', to],
      ['Cc', cc],
      ['Bcc', bcc],
    ];
    const lists: EmailAddress[][] = [];
    for (const [name, line] of lines) {
      const added = typed(line.typing);
      if (added === null && !quietly) {
        const invalid = parseAddresses(line.typing).invalid ?? line.typing;
        setProblem(`“${invalid}” in ${name} is not an address.`);
        return null;
      }
      lists.push([...line.list, ...(added ?? [])]);
    }
    return {
      ...draft,
      identityId,
      to: lists[0] ?? [],
      cc: lists[1] ?? [],
      bcc: lists[2] ?? [],
      subject: subject.trim(),
      html: words.current,
      ...(quote ? { quote } : { quote: undefined }),
      // Only the pictures still among the words, or in what they answer, go with them.
      pictures: pictures.filter((picture) =>
        `${words.current}${quote?.html ?? ''}`.includes(`cid:${picture.cid}`),
      ),
      attachments,
    };
  };

  /**
   * A message as it is to be kept or sent now, in place of the copy kept
   * last. Each time it is kept, what goes with it becomes part of the new
   * copy and the old copy is removed, so a file or picture is pointed at
   * where it was last put, not where it was when it was added.
   */
  const asKept = (message: Draft): Draft => {
    const now = <T extends Attachment>(part: T): T => {
      let blobId = part.blobId;
      for (let next; (next = moved.current.get(blobId)) !== undefined;) {
        blobId = next;
      }
      return { ...part, blobId };
    };
    return {
      ...message,
      attachments: message.attachments.map(now),
      pictures: message.pictures?.map(now),
      ...(kept.current ? { replaces: kept.current } : {}),
    };
  };

  /** Keeps what is written as a draft, after whatever is still being kept. */
  const keep = (): Promise<void> => {
    const message = written(true);
    const upTo = changes;
    const mine = turn.current.then(async () => {
      if (!message || upTo <= keptChanges.current) return;
      const saved = await store.saveDraft(asKept(message));
      kept.current = saved.id;
      for (const [before, now] of Object.entries(saved.blobs)) {
        if (before !== now) moved.current.set(before, now);
      }
      keptChanges.current = upTo;
      setKeptAt(new Date());
    });
    turn.current = mine.catch(() => undefined);
    return mine;
  };

  // Kept by itself a moment after the last change, so that nothing written is lost.
  const keeper = useRef(keep);
  keeper.current = keep;
  useEffect(() => {
    if (changes === 0) return undefined;
    const timer = window.setTimeout(() => {
      keeper.current().catch(() => undefined);
    }, KEEP_AFTER);
    return () => window.clearTimeout(timer);
  }, [changes]);

  const send = async (anyway = false, at?: Date) => {
    if (busy) return;
    const message = written(false);
    if (!message) return;
    if (message.to.length + message.cc.length + message.bcc.length === 0) {
      setProblem('Say who the message is for.');
      first.current?.focus();
      return;
    }
    if (
      !anyway &&
      attachments.length === 0 &&
      mentionsAttachment(message.html)
    ) {
      wanted.current = at;
      setAsking('attachment');
      return;
    }
    setBusy('sending');
    setAsking(null);
    try {
      await turn.current;
      // Held by the server first when it can be: until the time asked for, or
      // for the moment in which sending can be thought better of.
      const sending = store.send(
        asKept(message),
        at ? { at } : { holdFor: undoSeconds },
      );
      turn.current = sending.catch(() => undefined);
      const { emailId, submissionId } = await sending;
      const undo = submissionId
        ? {
            label: 'Undo',
            act: () => void unsend({ submissionId, emailId }),
          }
        : undefined;
      if (at && submissionId) {
        say(`It will be sent ${formatFull(at.toISOString())}`, {
          action: undo,
          seconds: 10,
        });
      } else {
        say('Message sent', undo ? { action: undo, seconds: undoSeconds } : {});
      }
      onClose();
    } catch (error) {
      setProblem(
        error instanceof MailError
          ? error.message
          : 'The message could not be sent. Check your connection and try again.',
      );
      setBusy(null);
    }
  };

  // The pictures of a draft opened again are fetched to be shown among its words.
  const made = useRef<string[]>([]);
  useEffect(() => {
    let current = true;
    for (const picture of draft.pictures ?? []) {
      void client
        .download(picture.blobId, { name: picture.name, type: picture.type })
        .then((bytes) => {
          if (!current) return;
          const url = URL.createObjectURL(
            new Blob([bytes as BlobPart], { type: picture.type }),
          );
          made.current.push(url);
          setShown((before) => ({ ...before, [picture.cid]: url }));
        })
        .catch(() => undefined);
    }
    const urls = made.current;
    return () => {
      current = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [client, draft]);

  const refuse = (file: File, error: unknown) =>
    setProblem(
      error instanceof JmapRequestError && error.status === 413
        ? `${file.name} is too large to attach.`
        : `${file.name} could not be attached.`,
    );
  const source = useMemo<PictureSource>(
    () => ({
      url: (cid) => shown[cid],
      add: async (file) => {
        setProblem(null);
        setAttaching((names) => [...names, file.name]);
        try {
          const uploaded = await client.upload(file, { type: file.type });
          const cid = `${crypto.randomUUID()}@mailless`;
          const url = URL.createObjectURL(file);
          made.current.push(url);
          setShown((before) => ({ ...before, [cid]: url }));
          setPictures((before) => [
            ...before,
            {
              cid,
              blobId: uploaded.blobId,
              name: file.name,
              type: file.type,
              size: file.size,
            },
          ]);
          return { cid, name: file.name };
        } catch (error) {
          refuse(file, error);
          throw error;
        } finally {
          setAttaching((names) => names.filter((name) => name !== file.name));
        }
      },
    }),
    [client, shown],
  );

  const attach = async (chosen: readonly File[]) => {
    setProblem(null);
    for (const file of chosen) {
      setAttaching((names) => [...names, file.name]);
      try {
        const type = file.type || 'application/octet-stream';
        const uploaded = await client.upload(file, { type });
        setAttachments((current) => [
          ...current,
          { blobId: uploaded.blobId, name: file.name, type, size: file.size },
        ]);
        changed();
      } catch (error) {
        refuse(file, error);
        setAttaching([]);
        break;
      }
      setAttaching((names) => names.filter((name) => name !== file.name));
    }
    if (files.current) files.current.value = '';
  };
  /** Pictures put on the words go among them, which the editor sees to; the rest is attached. */
  const toAttach = (target: EventTarget, given: FileList): File[] => {
    const onWords = (target as Element).closest?.('.editor-text') !== null;
    return [...given].filter((file) => !(onWords && isPicture(file)));
  };
  const drop = (event: DragEvent) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void attach(toAttach(event.target, event.dataTransfer.files));
  };
  const paste = (event: ClipboardEvent) => {
    if (event.clipboardData.files.length === 0) return;
    const files = toAttach(event.target, event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void attach(files);
  };

  /** Closing loses nothing: what was written stays as a draft. */
  const close = async () => {
    if (busy) return;
    if (changes > keptChanges.current) {
      setBusy('closing');
      try {
        await keep();
      } catch (error) {
        setProblem(
          error instanceof MailError
            ? error.message
            : 'The draft could not be kept. Check your connection and try again.',
        );
        setBusy(null);
        return;
      }
    }
    if (kept.current && changes > 0) say('Draft kept');
    onClose();
  };
  const discard = async () => {
    await turn.current;
    // The copy that was kept goes too: discarding means there is nothing left of it.
    const copy = kept.current;
    if (copy) await act(() => store.destroy([copy]));
    onClose();
  };

  const identity = store.identities.get(identityId);
  const signature = draft.unsigned
    ? ''
    : signatureBlock(identity).replace(/^-- \n/, '');
  const title = subject.trim() || (draft.answers ? 'Answer' : 'New message');
  const passing = draft.answers?.keyword === '$forwarded';
  const quoted = passing ? 'what you are passing on' : 'what you are answering';
  const status =
    busy === 'closing'
      ? 'Keeping…'
      : changes > keptChanges.current
        ? ''
        : keptAt
          ? `Draft kept at ${keptAt.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}`
          : '';

  return (
    <>
      {size === 'full' ? <div className="compose-scrim" /> : null}
      <section
        className={`compose compose-${size}${front ? '' : ' compose-back'}`}
        role="dialog"
        aria-label="Write a message"
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
        onPaste={paste}
      >
        <header className="compose-head">
          <h2 className="compose-title">{title}</h2>
          {size === 'minimised' && status ? (
            <span className="muted small">{status}</span>
          ) : null}
          <span className="compose-sizes">
            {size === 'minimised' ? (
              <IconButton
                icon="chevron-up"
                label="Open the window again"
                onClick={() => {
                  setView('docked');
                  onFront();
                }}
              />
            ) : (
              <IconButton
                icon="minimise"
                label="Minimise"
                onClick={() => setView('minimised')}
              />
            )}
            {size === 'full' ? (
              <IconButton
                icon="shrink"
                label="Leave full screen"
                onClick={() => setView('docked')}
              />
            ) : (
              <IconButton
                icon="expand"
                label="Full screen"
                onClick={() => {
                  setView('full');
                  onFront();
                }}
              />
            )}
          </span>
          <IconButton
            icon="close"
            label="Close"
            disabled={busy !== null}
            onClick={() => void close()}
          />
        </header>
        <form
          className="compose-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void send();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
        >
          <div className="compose-scroll">
            {identities.length > 1 ? (
              <div className="compose-row">
                <label htmlFor={`${uid}-from`}>From</label>
                <select
                  id={`${uid}-from`}
                  value={identityId}
                  onChange={(event) => edit(setIdentityId)(event.target.value)}
                >
                  {identities.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name ? `${each.name} <${each.email}>` : each.email}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <Recipients
              id={`${uid}-to`}
              label="To"
              value={to}
              input={first}
              suggest={suggest}
              onChange={edit(setTo)}
            >
              {others ? null : (
                <button
                  type="button"
                  className="button button-small button-quiet"
                  onClick={() => setOthers(true)}
                >
                  Cc, Bcc
                </button>
              )}
            </Recipients>
            {others ? (
              <>
                <Recipients
                  id={`${uid}-cc`}
                  label="Cc"
                  value={cc}
                  suggest={suggest}
                  onChange={edit(setCc)}
                />
                <Recipients
                  id={`${uid}-bcc`}
                  label="Bcc"
                  value={bcc}
                  suggest={suggest}
                  onChange={edit(setBcc)}
                />
              </>
            ) : null}
            <div className="compose-row">
              <label htmlFor={`${uid}-subject`}>Subject</label>
              <input
                id={`${uid}-subject`}
                className="compose-subject"
                value={subject}
                maxLength={500}
                onChange={(event) => edit(setSubject)(event.target.value)}
              />
            </div>
            <Editor
              html={draft.html}
              label="Message"
              tools={tools}
              focused={answering}
              bar={slot}
              pictures={source}
              onChange={(html) => {
                if (html === words.current) return;
                // Empty to begin with, the editor says so once: that is no change.
                const nothing =
                  !html.includes('<img') &&
                  plainOf(html) === '' &&
                  plainOf(words.current) === '';
                words.current = html;
                if (!nothing) changed();
              }}
            />
            {signature ? (
              <p className="compose-signature" aria-label="Signature">
                {signature}
              </p>
            ) : null}
            {quote ? (
              <div className="compose-quoted">
                <button
                  type="button"
                  className="quote-switch"
                  aria-expanded={quoteShown}
                  aria-label={`${quoteShown ? 'Hide' : 'Show'} ${quoted}`}
                  title={`${quoteShown ? 'Hide' : 'Show'} ${quoted}`}
                  onClick={() => setQuoteShown(!quoteShown)}
                >
                  ···
                </button>
                {quoteShown ? (
                  <>
                    <button
                      type="button"
                      className="button button-small button-quiet"
                      onClick={() => edit(setQuote)(undefined)}
                    >
                      Leave it out
                    </button>
                    <iframe
                      className="compose-quote"
                      title={quoted}
                      // Somebody else's page: no script runs in it, and it loads nothing.
                      sandbox="allow-same-origin"
                      referrerPolicy="no-referrer"
                      srcDoc={messageDocument(quote.html, { images: false })}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
            {attachments.length + attaching.length > 0 ? (
              <ul className="attachments" aria-label="Attached">
                {attachments.map((attachment, index) => (
                  <li
                    key={`${attachment.blobId}-${index}`}
                    className="attached"
                  >
                    <Icon name="file" size={18} />
                    <span className="attachment-name">{attachment.name}</span>
                    <span className="muted small">
                      {formatSize(attachment.size)}
                    </span>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() =>
                        edit(setAttachments)(
                          attachments.filter((_, each) => each !== index),
                        )
                      }
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </li>
                ))}
                {attaching.map((name, index) => (
                  <li key={`${name}-${index}`} className="attached">
                    <Icon name="file" size={18} />
                    <span className="attachment-name">{name}</span>
                    <span className="muted small">Attaching…</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {problem ? (
            <p className="notice notice-error" role="alert">
              {problem}
            </p>
          ) : null}
          {asking === 'attachment' ? (
            <div
              className="notice notice-warning"
              role="alertdialog"
              aria-label="Nothing is attached"
            >
              <p>You wrote of something attached, and nothing is.</p>
              <div className="row">
                <button
                  type="button"
                  className="button button-small button-primary"
                  onClick={() => {
                    setAsking(null);
                    files.current?.click();
                  }}
                >
                  Attach a file
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => void send(true, wanted.current)}
                >
                  Send as it is
                </button>
              </div>
            </div>
          ) : null}
          {asking === 'discard' ? (
            <div
              className="notice notice-warning"
              role="alertdialog"
              aria-label="Discard the message"
            >
              <p>Discard what you have written?</p>
              <div className="row">
                <button
                  type="button"
                  className="button button-small button-danger"
                  onClick={() => void discard()}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => setAsking(null)}
                >
                  Go on writing
                </button>
              </div>
            </div>
          ) : null}
          <div className="compose-bar">
            <button
              type="submit"
              className="button button-primary"
              disabled={busy !== null || attaching.length > 0}
            >
              {busy === 'sending' ? 'Sending…' : 'Send'}
            </button>
            {store.holdLimit > 0 ? (
              <SendLater
                disabled={busy !== null || attaching.length > 0}
                most={store.holdLimit}
                onPick={(at) => void send(false, at)}
              />
            ) : null}
            <IconButton
              icon="format"
              label="Formatting"
              pressed={tools}
              onClick={() => setTools(!tools)}
            />
            <span className="compose-slot" ref={setSlot} />
            <label className="icon-button" title="Attach files">
              <Icon name="attach" />
              <span className="visually-hidden">Attach files</span>
              <input
                ref={files}
                type="file"
                multiple
                className="visually-hidden"
                disabled={busy !== null}
                onChange={(event) =>
                  void attach([...(event.target.files ?? [])])
                }
              />
            </label>
            <span className="compose-status muted small" role="status">
              {status}
            </span>
            <IconButton
              icon="delete"
              label="Discard"
              disabled={busy !== null}
              onClick={() => {
                // Nothing written and nothing kept: there is nothing to ask about.
                if (changes === 0 && !kept.current) onClose();
                else setAsking('discard');
              }}
            />
          </div>
        </form>
      </section>
    </>
  );
}
