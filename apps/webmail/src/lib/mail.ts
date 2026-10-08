import {
  JmapMethodError,
  ObjectCache,
  QueryView,
  sync,
  type BatchResult,
  type JmapClient,
  type Synced,
} from '@mailless/jmap-client';
import type {
  Email,
  EmailAddress,
  Id,
  Identity,
  Mailbox,
  SetError,
  Thread,
} from '@mailless/jmap-core';

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

/** A message being written. */
export interface Draft {
  identityId: Id;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  text: string;
  attachments: Attachment[];
  /** The Message-IDs this answers and the conversation it belongs to. */
  inReplyTo?: string[] | null;
  references?: string[] | null;
  /** The message this answers or passes on, to mark it so once sent. */
  answers?: { emailId: Id; keyword: '$answered' | '$forwarded' };
  /** The saved draft this replaces. */
  replaces?: Id;
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

export class MailStore {
  readonly mailboxes: ObjectCache<Mailbox>;
  readonly identities: ObjectCache<Identity>;
  readonly emails: ObjectCache<Email>;
  readonly threads: ObjectCache<Thread>;
  private readonly lists = new Map<string, QueryView>();
  private refreshing: Promise<void> | undefined;
  private again = false;

  constructor(readonly client: JmapClient) {
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
            ? { text: key.search }
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

  /** The messages of a conversation that are held, oldest first. */
  conversation(threadId: Id): Email[] {
    const thread = this.threads.get(threadId);
    return (thread?.emailIds ?? [])
      .map((id) => this.emails.get(id))
      .filter((email): email is Email => email !== undefined)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
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
    for (const id of ids) {
      const email = this.emails.get(id);
      if (email) undo.set(id, this.emails.patch(id, local(email)));
    }
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
    return this.change(
      Object.fromEntries(
        emailIds.map((id) => [
          id,
          from === undefined
            ? { mailboxIds: { [to]: true } }
            : { [`mailboxIds/${from}`]: null, [`mailboxIds/${to}`]: true },
        ]),
      ),
      (email) => {
        const mailboxIds: Record<Id, true> =
          from === undefined ? {} : { ...email.mailboxIds };
        if (from !== undefined) delete mailboxIds[from];
        mailboxIds[to] = true;
        return { mailboxIds };
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
      bodyValues: { text: { value: draft.text } },
      textBody: [{ partId: 'text', type: 'text/plain' }],
      attachments: draft.attachments.map((attachment) => ({
        blobId: attachment.blobId,
        type: attachment.type,
        name: attachment.name,
        disposition: 'attachment',
      })),
    } as unknown as Partial<Email>;
  }

  private requireMailbox(role: string, what: string): Mailbox {
    const mailbox = this.mailbox(role);
    if (!mailbox)
      throw new MailError(`This account has no mailbox for ${what}.`);
    return mailbox;
  }

  /** Keeps a message being written, in place of the copy kept before. Returns the new copy's id. */
  async saveDraft(draft: Draft): Promise<Id> {
    const drafts = this.requireMailbox('drafts', 'drafts');
    const response = await this.client.call('Email/set', {
      create: { draft: this.message(draft, drafts.id) },
      // A message cannot be changed once it exists: the new copy replaces the old.
      ...(draft.replaces ? { destroy: [draft.replaces] } : {}),
    });
    const id = response.created?.['draft']?.id;
    if (!id) throw new MailError(describe(response.notCreated?.['draft']));
    await this.refresh();
    return id;
  }

  /** Sends a message, and files it under Sent. */
  async send(draft: Draft): Promise<void> {
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
      create: { send: { identityId: draft.identityId, emailId: '#draft' } },
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
    await this.refresh().catch(() => undefined);
  }
}
