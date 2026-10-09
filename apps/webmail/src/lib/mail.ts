import {
  capabilitiesFor,
  JmapMethodError,
  ObjectCache,
  QueryView,
  sync,
  type Batch,
  type BatchResult,
  type JmapClient,
  type Synced,
} from '@mailless/jmap-client';
import { CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from '@mailless/jmap-core';
import type {
  Email,
  EmailAddress,
  Id,
  Identity,
  Mailbox,
  SetError,
  Thread,
} from '@mailless/jmap-core';
import { bodiesOf } from './compose';
import { Contacts } from './contacts';
import { People } from './people';
import { filterOf, parseSearch } from './search';
import { Tags } from './tags';

/*
 * The mail as this page knows it: a copy of what it has looked at, kept in
 * step with the server, and everything that can be done to it. Nothing here
 * knows about the screen; the screen is drawn from it.
 */

/** What is held of every message that appears in a list. */
export const LIST_PROPERTIES = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'size',
  'receivedAt',
  'from',
  'to',
  'subject',
  'preview',
  'hasAttachment',
  // The names of what is attached, for the list: kept with the message's other details, not read from the message.
  'attachments',
];

/** What more is asked for of a message that is opened. */
const BODY_PROPERTIES = [
  'id',
  'cc',
  'bcc',
  'replyTo',
  'sender',
  'sentAt',
  'messageId',
  'inReplyTo',
  'references',
  'textBody',
  'htmlBody',
  'attachments',
  'bodyValues',
];

/** A body longer than this is cut short: nobody reads that much in a page. */
const MAX_BODY_BYTES = 512 * 1024;

/** The most messages changed in one call. Servers set their own limit; this is below any sensible one. */
const CHUNK = 100;

/**
 * How many lists are kept in step at once. The one being looked at is always
 * among them; one left longest ago is let go, and loaded again if returned to.
 */
const LISTS_KEPT = 6;

/** Something could not be done. The message is fit to show. */
export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

/** Which list of messages: those of a mailbox, or those a search finds. */
export type ListKey =
  | { mailboxId: Id; search?: undefined }
  | { search: string; mailboxId?: undefined };

export interface Attachment {
  blobId: Id;
  name: string;
  type: string;
  size: number;
}

/** A picture among the words of a message, which point at it by its `cid`. */
export interface Picture extends Attachment {
  cid: string;
}

/** How full a mailbox is, in bytes. `limit` is null when there is none. */
export interface Usage {
  used: number;
  limit: number | null;
}

/** A message being written. */
export interface Draft {
  identityId: Id;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  /** What was written, as the editor holds it. */
  html: string;
  /** What is being answered or passed on. It goes under what was written, as it is. */
  quote?: { text: string; html: string };
  /** Not signed when sent: a draft from elsewhere, which has its signature in its words. */
  unsigned?: boolean;
  /** The pictures among the words. One the words no longer point at is left behind. */
  pictures?: Picture[];
  attachments: Attachment[];
  /** The Message-IDs this answers and the conversation it belongs to. */
  inReplyTo?: string[] | null;
  references?: string[] | null;
  /** The message this answers or passes on, to mark it so once sent. */
  answers?: { emailId: Id; keyword: '$answered' | '$forwarded' };
  /** The saved draft this replaces. */
  replaces?: Id;
}

/** When to send: now, when nothing is said. */
export interface SendOptions {
  /** Held for this many seconds first, in which it can be taken back. */
  holdFor?: number;
  /** Held until then. */
  at?: Date;
}

/** A message the server is holding: not sent yet, and still possible to take back. */
export interface Held {
  submissionId: Id;
  emailId: Id;
  /** When it will be sent. */
  sendAt: string;
}

/**
 * What a message thrown away is marked with: the mailbox it was in, so that
 * it can be put back there. A keyword, so that it is known on every device.
 */
const WAS_IN = 'mailless-was-in-';

/**
 * The messages waiting to be sent. Asked for afresh only when something
 * about sending has changed: finding them means going through everything
 * that was ever sent.
 */
export class HeldSends implements Synced {
  private state: string | null = null;
  private byEmail = new Map<Id, Held>();
  private readonly listeners = new Set<() => void>();
  version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(emailId: Id): Held | undefined {
    return this.byEmail.get(emailId);
  }

  values(): Held[] {
    return [...this.byEmail.values()];
  }

  /** Something was sent or taken back from here: what is known is out of date. */
  touch(): void {
    this.state = null;
  }

  ask(batch: Batch): (result: BatchResult) => boolean {
    const known = this.state;
    if (known !== null) {
      const changes = batch.call('EmailSubmission/changes', {
        sinceState: known,
        maxChanges: 50,
      });
      return (result) => {
        try {
          if (result.get(changes).newState === known) return false;
        } catch {
          // Too much changed to be told what: asked afresh, like any change.
        }
        this.state = null;
        return true;
      };
    }
    const query = batch.call('EmailSubmission/query', {
      filter: { undoStatus: 'pending' },
    });
    const got = batch.call('EmailSubmission/get', {
      '#ids': query.ref('/ids'),
      properties: ['emailId', 'sendAt', 'undoStatus'],
    });
    return (result) => {
      let answer;
      try {
        answer = result.get(got);
      } catch {
        return false;
      }
      this.state = answer.state;
      const next = new Map<Id, Held>();
      for (const each of answer.list) {
        if (each.undoStatus !== 'pending') continue;
        next.set(each.emailId, {
          submissionId: each.id,
          emailId: each.emailId,
          sendAt: each.sendAt,
        });
      }
      const same =
        next.size === this.byEmail.size &&
        [...next].every(
          ([id, held]) =>
            this.byEmail.get(id)?.submissionId === held.submissionId,
        );
      this.byEmail = next;
      if (!same) {
        this.version++;
        for (const listener of [...this.listeners]) listener();
      }
      return false;
    };
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

function describe(error: SetError | undefined): string {
  switch (error?.type) {
    case 'overQuota':
      return 'The mailbox is full. Remove some mail and try again.';
    case 'tooLarge':
      return 'The message is too large to send.';
    case 'blobNotFound':
      return 'Something attached to the message is no longer there. Take it out and attach it again.';
    case 'tooManyRecipients':
      return 'The message has too many recipients.';
    case 'invalidRecipients':
    case 'noRecipients':
      return 'One of the addresses cannot be written to. Check them and try again.';
    case 'forbiddenFrom':
    case 'forbiddenMailFrom':
    case 'forbiddenToSend':
      return 'You may not send from this address.';
    default:
      return typeof error?.description === 'string' && error.description !== ''
        ? error.description
        : 'The server refused the change.';
  }
}

/** Where a message was and how it was marked, before something was done to it. */
type Before = Pick<Email, 'mailboxIds' | 'keywords'>;

export class MailStore {
  readonly mailboxes: ObjectCache<Mailbox>;
  readonly identities: ObjectCache<Identity>;
  readonly emails: ObjectCache<Email>;
  readonly threads: ObjectCache<Thread>;
  /** The messages waiting to be sent. */
  readonly held = new HeldSends();
  /** Who a message might be for. Found out when one is first written. */
  readonly people: People;
  /** The address book. Fetched when it is first looked at, or a message first written. */
  readonly contacts: Contacts;
  readonly tags: Tags;
  /**
   * For how long the server will hold a message before sending it, in
   * seconds. Nought when it cannot, or when this account cannot send.
   */
  holdLimit = 0;
  private readonly lists = new Map<string, QueryView>();
  private refreshing: Promise<void> | undefined;
  /** How many changes have been made, and how the messages of the last few were before. */
  private changes = 0;
  private readonly done: Array<{ at: number; was: Map<Id, Before> }> = [];
  private again = false;

  constructor(readonly client: JmapClient) {
    this.contacts = new Contacts(client);
    this.tags = new Tags(client);
    this.people = new People(client, this.contacts);
    this.mailboxes = new ObjectCache(client, {
      type: 'Mailbox',
      everything: true,
    });
    this.identities = new ObjectCache(client, {
      type: 'Identity',
      everything: true,
    });
    this.emails = new ObjectCache(client, {
      type: 'Email',
      properties: LIST_PROPERTIES,
      // Nothing else of a message changes once it exists.
      changing: ['mailboxIds', 'keywords'],
    });
    this.threads = new ObjectCache(client, { type: 'Thread' });
  }

  /** Loads what every screen needs: the mailboxes and who the user may write as. */
  async start(): Promise<void> {
    const batch = this.client.batch();
    const mailboxes = this.mailboxes.loadIn(batch, null);
    const identities = this.identities.loadIn(batch, null);
    const result = await batch.send();
    mailboxes.done(result);
    // An account that cannot send has no identities to ask for.
    if (result.ok(identities.call)) identities.done(result);
    const session = await this.client.session();
    const sending = session.capabilities[CAPABILITY_SUBMISSION] as
      { submissionExtensions?: Record<string, string[]> } | undefined;
    const most = Number(sending?.submissionExtensions?.['FUTURERELEASE']?.[0]);
    this.holdLimit = Number.isFinite(most) && most > 0 ? most : 0;
    // What the tags are called, before any list is asked for by one of them.
    await this.tags.start().catch(() => undefined);
  }

  /** The mailbox with a role: `inbox`, `trash`. */
  mailbox(role: string): Mailbox | undefined {
    return this.mailboxes.values().find((mailbox) => mailbox.role === role);
  }

  /** The list for a mailbox or a search. The same one each time it is asked for. */
  list(key: ListKey): QueryView {
    const name = JSON.stringify([key.mailboxId ?? null, key.search ?? null]);
    let view = this.lists.get(name);
    // Asked for again is used again: it goes to the end, the last to be let go.
    if (view) this.lists.delete(name);
    if (!view) {
      view = new QueryView(this.client, {
        type: 'Email',
        filter:
          key.search !== undefined
            ? filterOf(
                parseSearch(key.search),
                this.mailboxes.values(),
                new Date(),
                this.tags.all(),
              )
            : { inMailbox: key.mailboxId },
        sort: [{ property: 'receivedAt', isAscending: false }],
        // A conversation is one row, whatever number of messages it has.
        arguments: { collapseThreads: true },
      });
    }
    this.lists.set(name, view);
    for (const oldest of this.lists.keys()) {
      if (this.lists.size <= LISTS_KEPT) break;
      this.lists.delete(oldest);
    }
    return view;
  }

  /**
   * A page of a list and all that a row shows of each conversation in it, in
   * one request: the messages found, their conversations, and the other
   * messages of those.
   */
  private async page(view: QueryView, more: boolean): Promise<void> {
    const batch = this.client.batch();
    const found = view.loadIn(batch, { more });
    if (!found) return;
    const emails = this.emails.loadIn(batch, found.call.ref('/ids'));
    const threads = this.threads.loadIn(
      batch,
      emails.call.ref('/list/*/threadId'),
    );
    const others = this.emails.loadIn(
      batch,
      threads.call.ref('/list/*/emailIds'),
    );
    const result = await batch.send();
    emails.done(result);
    threads.done(result);
    others.done(result);
    found.done(result);
    // The list moved while it was asked for: bring everything up to date.
    if (view.ids.some((id) => !this.emails.get(id))) await this.refresh();
  }

  /** Loads the top of a list, once. */
  open(view: QueryView): Promise<void> {
    return this.page(view, false);
  }

  /** Loads the next page of a list. */
  more(view: QueryView): Promise<void> {
    return this.page(view, true);
  }

  /** Asks the server what changed, and brings everything held up to date. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      // Something changed after the one under way was asked: ask once more after it.
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        const parts: Synced[] = [
          this.mailboxes,
          // Who the user writes as, and how they sign: changed in the settings of any device.
          ...(this.identities.isComplete ? [this.identities] : []),
          this.emails,
          this.threads,
          ...(this.holdLimit > 0 ? [this.held] : []),
          ...(this.tags.made.isComplete ? [this.tags.made] : []),
          ...this.lists.values(),
        ];
        await sync(this.client, parts);
        await this.fill();
      } while (this.again);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Loads what the lists and conversations held now name and is not held yet. */
  private async fill(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const emailIds = new Set<Id>();
      for (const view of this.lists.values()) {
        for (const id of view.ids) emailIds.add(id);
      }
      for (const thread of this.threads.values()) {
        for (const id of thread.emailIds) emailIds.add(id);
      }
      const missing = [...emailIds].filter((id) => !this.emails.get(id));
      const threadIds = new Set<Id>();
      for (const view of this.lists.values()) {
        for (const id of view.ids) {
          const threadId = this.emails.get(id)?.threadId;
          if (threadId && !this.threads.get(threadId)) threadIds.add(threadId);
        }
      }
      if (missing.length === 0 && threadIds.size === 0) return;

      const batch = this.client.batch();
      const asked: Array<{ done(result: BatchResult): unknown }> = [];
      if (threadIds.size > 0) {
        asked.push(this.threads.loadIn(batch, [...threadIds]));
      }
      if (missing.length > 0) {
        const emails = this.emails.loadIn(batch, missing.slice(0, 500));
        asked.push(
          emails,
          this.threads.loadIn(batch, emails.call.ref('/list/*/threadId')),
        );
      }
      const result = await batch.send();
      for (const each of asked) each.done(result);
    }
  }

  /**
   * The messages of a conversation that are held, oldest first, as seen from
   * a mailbox. What was thrown away or is junk is not part of it any more:
   * it is seen in the trash or the junk, where nothing else of it is.
   */
  conversation(threadId: Id, from?: Mailbox): Email[] {
    const thread = this.threads.get(threadId);
    const all = (thread?.emailIds ?? [])
      .map((id) => this.emails.get(id))
      .filter((email): email is Email => email !== undefined)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const away = this.awayIds();
    if (from && away.has(from.id)) {
      return all.filter((email) => email.mailboxIds[from.id]);
    }
    const kept = all.filter((email) =>
      Object.keys(email.mailboxIds).some((id) => !away.has(id)),
    );
    // A search finds what is in the trash too, and it has to be readable from there.
    return kept.length > 0 || from ? kept : all;
  }

  /** Loads a conversation whole, with the text of each of its messages. */
  async read(threadId: Id): Promise<void> {
    if (!this.threads.get(threadId)) {
      const batch = this.client.batch();
      const thread = this.threads.loadIn(batch, [threadId]);
      const emails = this.emails.loadIn(
        batch,
        thread.call.ref('/list/*/emailIds'),
      );
      const result = await batch.send();
      thread.done(result);
      emails.done(result);
    }
    const thread = this.threads.get(threadId);
    if (!thread) throw new MailError('This conversation is no longer there.');
    await this.emails.load(thread.emailIds);
    await this.bodies(thread.emailIds);
  }

  /** Loads the text of messages that do not have it yet. */
  async bodies(emailIds: readonly Id[]): Promise<void> {
    const without = emailIds.filter(
      (id) => this.emails.get(id)?.bodyValues === undefined,
    );
    if (without.length === 0) return;
    await this.emails.fetch(without, {
      properties: BODY_PROPERTIES,
      bodyProperties: [
        'partId',
        'blobId',
        'size',
        'name',
        'type',
        'charset',
        'disposition',
        'cid',
      ],
      fetchHTMLBodyValues: true,
      fetchTextBodyValues: true,
      maxBodyValueBytes: MAX_BODY_BYTES,
    });
  }

  /**
   * Changes messages: here at once, then on the server. What the server
   * refuses is put back as it was, and the first refusal is thrown.
   */
  private async change(
    updates: Record<Id, Record<string, unknown>>,
    local: (email: Email) => Partial<Email>,
  ): Promise<void> {
    const ids = Object.keys(updates);
    if (ids.length === 0) return;
    const undo = new Map<Id, () => void>();
    const was = new Map<Id, Before>();
    for (const id of ids) {
      const email = this.emails.get(id);
      if (!email) continue;
      was.set(id, { mailboxIds: email.mailboxIds, keywords: email.keywords });
      undo.set(id, this.emails.patch(id, local(email)));
    }
    // Kept for a while, so that what was just done can be taken back.
    this.done.push({ at: ++this.changes, was });
    if (this.done.length > 20) this.done.shift();
    let refused: SetError | undefined;
    try {
      for (const chunk of chunks(ids, CHUNK)) {
        const response = await this.client.call('Email/set', {
          update: Object.fromEntries(
            chunk.map((id) => [id, updates[id] ?? {}]),
          ),
        });
        for (const [id, error] of Object.entries(response.notUpdated ?? {})) {
          // Gone already is what was wanted of something being moved away or marked.
          if (error.type === 'notFound') continue;
          undo.get(id)?.();
          refused ??= error;
        }
      }
    } catch (error) {
      for (const back of undo.values()) back();
      void this.refresh().catch(() => undefined);
      throw error;
    }
    await this.refresh();
    if (refused) throw new MailError(describe(refused));
  }

  /** A point in what has been changed, to take things back to. */
  mark(): number {
    return this.changes;
  }

  /**
   * The way to take back what was changed since a mark: every message put
   * where it was, marked as it was. Null when nothing was changed that can be:
   * what was deleted permanently cannot.
   */
  undoSince(mark: number): (() => Promise<void>) | null {
    const was = new Map<Id, Before>();
    for (const entry of this.done) {
      if (entry.at <= mark) continue;
      // The first of several changes to one message is how it was to begin with.
      for (const [id, before] of entry.was)
        if (!was.has(id)) was.set(id, before);
    }
    if (was.size === 0) return null;
    return () => {
      const ids = [...was.keys()].filter((id) => this.emails.get(id));
      this.dropFromLists(ids);
      return this.change(
        Object.fromEntries(ids.map((id) => [id, { ...was.get(id) }])),
        (email) => was.get(email.id) ?? {},
      );
    };
  }

  /** Sets or clears a keyword on messages: `$seen`, `$flagged`. */
  setKeyword(
    emailIds: readonly Id[],
    keyword: string,
    on: boolean,
  ): Promise<void> {
    const changing = emailIds.filter((id) => {
      const email = this.emails.get(id);
      return !email || (email.keywords[keyword] === true) !== on;
    });
    return this.change(
      Object.fromEntries(
        changing.map((id) => [
          id,
          { [`keywords/${keyword}`]: on ? true : null },
        ]),
      ),
      (email) => {
        const keywords = { ...email.keywords };
        if (on) keywords[keyword] = true;
        else delete keywords[keyword];
        return { keywords };
      },
    );
  }

  /**
   * Moves messages to a mailbox. Out of `from` when that is named, leaving
   * them in any other mailbox they are in; otherwise out of everywhere.
   */
  move(emailIds: readonly Id[], to: Id, from?: Id): Promise<void> {
    if (from === to) return Promise.resolve();
    this.dropFromLists(emailIds, from);
    const away = this.awayIds();
    /** What is noted on a message, or struck from it, about where it was. */
    const notes = (email: Email | undefined): Record<string, boolean> => {
      if (!email) return {};
      const noted = Object.keys(email.keywords).filter((keyword) =>
        keyword.startsWith(WAS_IN),
      );
      // Out of the trash or the junk by hand: where it was is no longer where it would go back to.
      if (!away.has(to)) {
        return Object.fromEntries(noted.map((keyword) => [keyword, false]));
      }
      const leaving = Object.keys(email.mailboxIds).filter(
        (id) => !away.has(id) && (from === undefined || id === from),
      );
      // From the trash to the junk, or the other way: what was noted still holds.
      if (leaving.length === 0) return {};
      return {
        ...Object.fromEntries(noted.map((keyword) => [keyword, false])),
        ...Object.fromEntries(
          leaving.map((id) => [`${WAS_IN}${id.toLowerCase()}`, true]),
        ),
      };
    };
    return this.change(
      Object.fromEntries(
        emailIds.map((id) => [
          id,
          {
            ...(from === undefined
              ? { mailboxIds: { [to]: true } }
              : { [`mailboxIds/${from}`]: null, [`mailboxIds/${to}`]: true }),
            ...Object.fromEntries(
              Object.entries(notes(this.emails.get(id))).map(
                ([keyword, on]) => [`keywords/${keyword}`, on ? true : null],
              ),
            ),
          },
        ]),
      ),
      (email) => {
        const mailboxIds: Record<Id, true> =
          from === undefined ? {} : { ...email.mailboxIds };
        if (from !== undefined) delete mailboxIds[from];
        mailboxIds[to] = true;
        const keywords = { ...email.keywords };
        for (const [keyword, on] of Object.entries(notes(email))) {
          if (on) keywords[keyword] = true;
          else delete keywords[keyword];
        }
        return { mailboxIds, keywords };
      },
    );
  }

  /** The trash and the junk: where what is not wanted is put. */
  private awayIds(): Set<Id> {
    return new Set(
      [this.mailbox('trash'), this.mailbox('junk')].flatMap((mailbox) =>
        mailbox ? [mailbox.id] : [],
      ),
    );
  }

  /**
   * Where messages in the trash or the junk would go back to: where each was
   * when it was put there, as noted on it then. The inbox for one nothing is
   * noted on, as when another program threw it away.
   */
  wasIn(emailIds: readonly Id[]): Mailbox[] {
    const away = this.awayIds();
    const mailboxes = this.mailboxes.values();
    const found = new Map<Id, Mailbox>();
    for (const id of emailIds) {
      const keywords = Object.keys(this.emails.get(id)?.keywords ?? {});
      const noted = keywords
        .filter((keyword) => keyword.startsWith(WAS_IN))
        .map((keyword) => keyword.slice(WAS_IN.length))
        .flatMap((was) =>
          // A keyword comes back in small letters, whatever the id was written in.
          mailboxes.filter(
            (mailbox) =>
              mailbox.id.toLowerCase() === was && !away.has(mailbox.id),
          ),
        );
      const inbox = this.mailbox('inbox');
      for (const mailbox of noted.length > 0 ? noted : inbox ? [inbox] : []) {
        found.set(mailbox.id, mailbox);
      }
    }
    return [...found.values()];
  }

  /** Puts messages in the trash or the junk back where each of them was. */
  restore(emailIds: readonly Id[]): Promise<void> {
    const to = new Map(
      emailIds.map((id) => [id, this.wasIn([id]).map((mailbox) => mailbox.id)]),
    );
    const moving = emailIds.filter((id) => (to.get(id)?.length ?? 0) > 0);
    this.dropFromLists(moving);
    const noted = (email: Email | undefined) =>
      Object.keys(email?.keywords ?? {}).filter((keyword) =>
        keyword.startsWith(WAS_IN),
      );
    return this.change(
      Object.fromEntries(
        moving.map((id) => [
          id,
          {
            mailboxIds: Object.fromEntries(
              (to.get(id) ?? []).map((mailboxId) => [mailboxId, true]),
            ),
            ...Object.fromEntries(
              noted(this.emails.get(id)).map((keyword) => [
                `keywords/${keyword}`,
                null,
              ]),
            ),
          },
        ]),
      ),
      (email) => {
        const keywords = { ...email.keywords };
        for (const keyword of noted(email)) delete keywords[keyword];
        return {
          mailboxIds: Object.fromEntries(
            (to.get(email.id) ?? []).map((mailboxId) => [mailboxId, true]),
          ),
          keywords,
        };
      },
    );
  }

  /**
   * Takes messages off the mailbox lists they are leaving, before the server
   * has said so. A search still finds what was moved, so those lists stay.
   */
  private dropFromLists(emailIds: readonly Id[], from?: Id): void {
    for (const [name, view] of this.lists) {
      const [mailboxId] = JSON.parse(name) as [Id | null, string | null];
      if (mailboxId === null) continue;
      if (from !== undefined && mailboxId !== from) continue;
      view.drop(emailIds);
    }
  }

  /** Removes messages for good. */
  async destroy(emailIds: readonly Id[]): Promise<void> {
    if (emailIds.length === 0) return;
    for (const view of this.lists.values()) view.drop(emailIds);
    let refused: SetError | undefined;
    try {
      for (const chunk of chunks(emailIds, CHUNK)) {
        const response = await this.client.call('Email/set', {
          destroy: chunk,
        });
        refused ??= Object.values(response.notDestroyed ?? {}).find(
          (error) => error.type !== 'notFound',
        );
      }
    } finally {
      await this.refresh().catch(() => undefined);
    }
    if (refused) throw new MailError(describe(refused));
  }

  /** To the trash; and from the trash, or when there is none, gone for good. */
  remove(emailIds: readonly Id[]): Promise<void> {
    const trash = this.mailbox('trash');
    if (!trash) return this.destroy(emailIds);
    const there = emailIds.filter(
      (id) => this.emails.get(id)?.mailboxIds[trash.id] === true,
    );
    const elsewhere = emailIds.filter((id) => !there.includes(id));
    return Promise.all([
      this.destroy(there),
      elsewhere.length > 0 ? this.move(elsewhere, trash.id) : undefined,
    ]).then(() => undefined);
  }

  /** Removes every message of a mailbox for good. Returns how many. */
  async empty(mailboxId: Id): Promise<number> {
    let removed = 0;
    try {
      for (;;) {
        const batch = this.client.batch();
        const found = batch.call('Email/query', {
          filter: { inMailbox: mailboxId },
          limit: CHUNK,
        });
        const destroyed = batch.call('Email/set', {
          '#destroy': found.ref('/ids'),
        });
        const result = await batch.send();
        const count = result.get(destroyed).destroyed?.length ?? 0;
        removed += count;
        const refused = Object.values(
          result.get(destroyed).notDestroyed ?? {},
        ).find((error) => error.type !== 'notFound');
        if (refused) throw new MailError(describe(refused));
        if (result.get(found).ids.length < CHUNK || count === 0) break;
      }
    } finally {
      await this.refresh().catch(() => undefined);
    }
    return removed;
  }

  /** Makes a mailbox. Returns its id. */
  async createMailbox(name: string, parentId: Id | null = null): Promise<Id> {
    const response = await this.client.call('Mailbox/set', {
      create: { new: { name, parentId } },
    });
    const id = response.created?.['new']?.id;
    if (!id) {
      const error = response.notCreated?.['new'];
      throw new MailError(
        error?.type === 'invalidProperties'
          ? 'A mailbox with that name cannot be made. Is there one already?'
          : describe(error),
      );
    }
    await this.refresh();
    return id;
  }

  /** Gives a mailbox another name, or puts it inside another one (or inside none). */
  async changeMailbox(
    id: Id,
    change: { name?: string; parentId?: Id | null },
  ): Promise<void> {
    const response = await this.client.call('Mailbox/set', {
      update: { [id]: change },
    });
    const error = response.notUpdated?.[id];
    await this.refresh();
    if (error) {
      throw new MailError(
        error.type === 'invalidProperties'
          ? 'That cannot be done. Is there a mailbox with that name there already?'
          : describe(error),
      );
    }
  }

  /**
   * Removes a mailbox. What is in it goes to the trash, where it can still
   * be had back; what is in another mailbox as well only leaves this one.
   * Without a trash to put it in, it is removed with the mailbox.
   */
  async removeMailbox(id: Id): Promise<void> {
    if (this.mailboxes.values().some((mailbox) => mailbox.parentId === id)) {
      throw new MailError(
        'There are mailboxes inside this one. Move or delete them first.',
      );
    }
    const trash = this.mailbox('trash');
    try {
      // Until it holds nothing: each round takes away what the last one found.
      for (let round = 0; trash && trash.id !== id && round < 1000; round++) {
        const batch = this.client.batch();
        const found = batch.call('Email/query', {
          filter: { inMailbox: id },
          limit: CHUNK,
        });
        const read = batch.call('Email/get', {
          '#ids': found.ref('/ids'),
          properties: ['mailboxIds'],
        });
        const result = await batch.send();
        const emails = result.get(read).list;
        if (emails.length === 0) break;
        const response = await this.client.call('Email/set', {
          update: Object.fromEntries(
            emails.map((email) => [
              email.id,
              Object.keys(email.mailboxIds).length > 1
                ? { [`mailboxIds/${id}`]: null }
                : {
                    mailboxIds: { [trash.id]: true },
                    // Where it was, though it will not be there to go back to.
                    [`keywords/${WAS_IN}${id.toLowerCase()}`]: true,
                  },
            ]),
          ),
        });
        const refused = Object.values(response.notUpdated ?? {}).find(
          (error) => error.type !== 'notFound',
        );
        if (refused) throw new MailError(describe(refused));
      }
      const response = await this.client.call('Mailbox/set', {
        destroy: [id],
        // With a trash it is empty by now; without one, this is all there is to do.
        onDestroyRemoveEmails: !trash,
      });
      const error = response.notDestroyed?.[id];
      if (error && error.type !== 'notFound') {
        throw new MailError(
          error.type === 'mailboxHasChild'
            ? 'There are mailboxes inside this one. Move or delete them first.'
            : describe(error),
        );
      }
    } finally {
      await this.refresh().catch(() => undefined);
    }
  }

  /** How full the mailbox is, or null when the server does not say (RFC 9425). */
  async usage(): Promise<Usage | null> {
    const response = (await this.client.call(
      'Quota/get',
      { ids: null },
      // A server says how full mail is to those who say they are asking about mail.
      { using: [...capabilitiesFor(['Quota/get']), CAPABILITY_MAIL] },
    )) as {
      list?: Array<{
        resourceType?: string;
        used?: number;
        hardLimit?: number | null;
      }>;
    };
    const quota = response.list?.find(
      (each) => each.resourceType === 'octets' && typeof each.used === 'number',
    );
    if (!quota) return null;
    return {
      used: quota.used as number,
      limit:
        typeof quota.hardLimit === 'number' && quota.hardLimit > 0
          ? quota.hardLimit
          : null,
    };
  }

  /** Changes the name someone writes under, or how they sign, for one of their addresses. */
  async updateIdentity(
    id: Id,
    changes: { name?: string; textSignature?: string },
  ): Promise<void> {
    const response = await this.client.call('Identity/set', {
      update: { [id]: changes },
    });
    const refused = response.notUpdated?.[id];
    if (refused) {
      throw new MailError(
        refused.type === 'invalidProperties'
          ? 'That is too long, or has something in it a name or a signature cannot have.'
          : describe(refused),
      );
    }
    await this.identities.sync();
  }

  private message(draft: Draft, mailboxId: Id): Partial<Email> {
    const identity = this.identities.get(draft.identityId);
    if (!identity) throw new MailError('Choose who the message is from.');
    const bodies = bodiesOf(draft, identity);
    const text = { partId: 'text', type: 'text/plain' };
    const html = { partId: 'html', type: 'text/html' };
    const attachments = draft.attachments.map((attachment) => ({
      blobId: attachment.blobId,
      type: attachment.type,
      name: attachment.name,
      disposition: 'attachment',
    }));
    const pictures = (draft.pictures ?? [])
      .filter((picture) => bodies.html.includes(`cid:${picture.cid}`))
      .map((picture) => ({
        blobId: picture.blobId,
        type: picture.type,
        name: picture.name,
        disposition: 'inline',
        cid: picture.cid,
      }));
    // Pictures travel beside the page that shows them, which is said by how the parts are nested.
    const words = {
      type: 'multipart/alternative',
      subParts: [
        text,
        { type: 'multipart/related', subParts: [html, ...pictures] },
      ],
    };
    return {
      mailboxIds: { [mailboxId]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: identity.name || null, email: identity.email }],
      to: draft.to,
      cc: draft.cc.length > 0 ? draft.cc : null,
      bcc: draft.bcc.length > 0 ? draft.bcc : null,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo ?? null,
      references: draft.references ?? null,
      bodyValues: {
        text: { value: bodies.text },
        html: { value: bodies.html },
      },
      ...(pictures.length === 0
        ? { textBody: [text], htmlBody: [html], attachments }
        : {
            bodyStructure:
              attachments.length === 0
                ? words
                : {
                    type: 'multipart/mixed',
                    subParts: [words, ...attachments],
                  },
          }),
    } as unknown as Partial<Email>;
  }

  private requireMailbox(role: string, what: string): Mailbox {
    const mailbox = this.mailbox(role);
    if (!mailbox)
      throw new MailError(`This account has no mailbox for ${what}.`);
    return mailbox;
  }

  /**
   * Keeps a message being written, in place of the copy kept before.
   * Returns the new copy's id, and where what goes with the message is
   * now: each file and picture is a part of the copy that was made, and
   * the part of the copy before it, which it may have been until now, is
   * gone with that copy. Whoever goes on writing must point at the new ones.
   */
  async saveDraft(draft: Draft): Promise<{ id: Id; blobs: Record<Id, Id> }> {
    const drafts = this.requireMailbox('drafts', 'drafts');
    const response = await this.client.call('Email/set', {
      create: { draft: this.message(draft, drafts.id) },
      // A message cannot be changed once it exists: the new copy replaces the old.
      ...(draft.replaces ? { destroy: [draft.replaces] } : {}),
    });
    const id = response.created?.['draft']?.id;
    if (!id) throw new MailError(describe(response.notCreated?.['draft']));

    const blobs: Record<Id, Id> = {};
    if (draft.attachments.length + (draft.pictures?.length ?? 0) > 0) {
      const made = await this.client.call('Email/get', {
        ids: [id],
        properties: ['attachments'],
      });
      // Pictures are known by their own ids; the files come back in the order they were given.
      const files = [...draft.attachments];
      for (const part of made.list[0]?.attachments ?? []) {
        if (!part.blobId) continue;
        const cid = part.cid?.replace(/^<|>$/g, '');
        const picture = draft.pictures?.find((each) => each.cid === cid);
        const before = picture ?? files.shift();
        if (before) blobs[before.blobId] = part.blobId;
      }
    }
    await this.refresh();
    return { id, blobs };
  }

  /**
   * Sends a message, and files it under Sent: now, or held by the server
   * first, for a few seconds or until a time. Held, it can be taken back
   * with `unsend`. Returns what was made, with `submissionId` set when it
   * is being held.
   */
  async send(
    draft: Draft,
    options: SendOptions = {},
  ): Promise<{ emailId: Id; submissionId: Id | null }> {
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      throw new MailError('Say who the message is for.');
    }
    const drafts = this.requireMailbox('drafts', 'drafts');
    const sent = this.mailbox('sent');
    const batch = this.client.batch();
    const created = batch.call('Email/set', {
      create: { draft: this.message(draft, drafts.id) },
    });
    const submitted = batch.call('EmailSubmission/set', {
      create: {
        send: {
          identityId: draft.identityId,
          emailId: '#draft',
          ...this.envelope(draft, options),
        },
      },
      onSuccessUpdateEmail: {
        '#send': {
          'keywords/$draft': null,
          ...(sent
            ? {
                [`mailboxIds/${drafts.id}`]: null,
                [`mailboxIds/${sent.id}`]: true,
              }
            : {}),
        },
      },
    });
    const result = await batch.send();

    const emailId = result.get(created).created?.['draft']?.id;
    if (!emailId) {
      throw new MailError(describe(result.get(created).notCreated?.['draft']));
    }
    let failure: SetError | undefined;
    try {
      failure = result.get(submitted).notCreated?.['send'];
    } catch (error) {
      if (!(error instanceof JmapMethodError)) throw error;
      failure = { type: error.type as SetError['type'] };
    }
    if (failure) {
      // Not sent: what was written is not lost, it stays as a draft.
      await this.refresh().catch(() => undefined);
      throw new MailError(
        `${describe(failure)} The message was kept as a draft.`,
      );
    }

    // Sent. What follows tidies up, and its failing does not unsend anything.
    const after = this.client.batch();
    if (draft.replaces) {
      after.call('Email/set', { destroy: [draft.replaces] });
    }
    if (draft.answers) {
      after.call('Email/set', {
        update: {
          [draft.answers.emailId]: {
            [`keywords/${draft.answers.keyword}`]: true,
          },
        },
      });
    }
    if (draft.replaces || draft.answers) {
      await after.send().catch(() => undefined);
    }
    this.held.touch();
    this.people.note([...draft.to, ...draft.cc, ...draft.bcc]);
    await this.refresh().catch(() => undefined);
    const held = this.envelope(draft, options).envelope !== undefined;
    const submissionId = result.get(submitted).created?.['send']?.id ?? null;
    return { emailId, submissionId: held ? submissionId : null };
  }

  /**
   * How a message that is to be held is addressed. Holding is asked for
   * where the sender is named, so everyone it goes to is named there too.
   */
  private envelope(
    draft: Draft,
    options: SendOptions,
  ): { envelope?: Record<string, unknown> } {
    const identity = this.identities.get(draft.identityId);
    const hold =
      options.at !== undefined
        ? { HOLDUNTIL: options.at.toISOString().replace(/\.\d+Z$/, 'Z') }
        : options.holdFor !== undefined && options.holdFor > 0
          ? { HOLDFOR: String(Math.round(options.holdFor)) }
          : null;
    if (!hold || !identity || this.holdLimit === 0) return {};
    return {
      envelope: {
        mailFrom: { email: identity.email, parameters: hold },
        rcptTo: [...draft.to, ...draft.cc, ...draft.bcc].map((address) => ({
          email: address.email,
          parameters: null,
        })),
      },
    };
  }

  /**
   * Takes back a message the server is holding, and puts it among the
   * drafts again, to go on with or to discard. Fails when it has gone.
   */
  async unsend(held: Pick<Held, 'submissionId' | 'emailId'>): Promise<void> {
    const drafts = this.requireMailbox('drafts', 'drafts');
    const canceled = await this.client.call('EmailSubmission/set', {
      update: { [held.submissionId]: { undoStatus: 'canceled' } },
    });
    this.held.touch();
    if (canceled.notUpdated?.[held.submissionId]) {
      await this.refresh().catch(() => undefined);
      throw new MailError('It is too late to take it back: it has been sent.');
    }
    await this.client.call('Email/set', {
      update: {
        [held.emailId]: {
          mailboxIds: { [drafts.id]: true },
          'keywords/$draft': true,
        },
      },
    });
    await this.refresh();
    // It may be in no list that is open here: fetched whole, to go on writing it.
    await this.emails.fetch([held.emailId], {
      properties: [...LIST_PROPERTIES],
    });
    await this.bodies([held.emailId]);
  }
}
