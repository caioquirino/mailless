import { usageOps } from './quota.js';
import {
  asJson,
  EMAIL,
  emailIndexes,
  isUnread,
  MAILBOX,
  MAILBOX_COUNT_PROPERTIES,
  THREAD,
  type EmailRecord,
  type EmailValue,
  type MailboxCounts,
  type ThreadRecord,
} from './model.js';
import { destroyTextOps, emailTextOp, type EmailTextValue } from './search.js';

import {
  ConflictError,
  commit,
  retryOnConflict,
  type MethodContext,
  type WriteOp,
} from '@mailless/jmap-engine';
export type EmailMutation =
  | {
      kind: 'create';
      id: string;
      value: EmailValue;
      /** The email's searchable text, stored alongside it. */
      text?: EmailTextValue;
    }
  | {
      kind: 'update';
      id: string;
      value: EmailValue;
      changedProperties: string[];
    }
  | { kind: 'destroy'; id: string };

function zeroCounts(): MailboxCounts {
  return { totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 };
}

/** What one thread contributes to the counts of each mailbox it appears in. */
export function threadContribution(
  emails: Iterable<EmailValue>,
): Map<string, MailboxCounts> {
  const list = [...emails];
  const threadUnread = list.some((email) => isUnread(email.keywords));
  const result = new Map<string, MailboxCounts>();

  for (const email of list) {
    for (const mailboxId of Object.keys(email.mailboxIds)) {
      let counts = result.get(mailboxId);
      if (!counts) {
        counts = zeroCounts();
        result.set(mailboxId, counts);
      }
      counts.totalEmails += 1;
      if (isUnread(email.keywords)) counts.unreadEmails += 1;
      counts.totalThreads = 1;
      counts.unreadThreads = threadUnread ? 1 : 0;
    }
  }
  return result;
}

export function countDeltas(
  before: Map<string, MailboxCounts>,
  after: Map<string, MailboxCounts>,
): Map<string, MailboxCounts> {
  const deltas = new Map<string, MailboxCounts>();
  for (const mailboxId of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(mailboxId) ?? zeroCounts();
    const to = after.get(mailboxId) ?? zeroCounts();
    const delta = zeroCounts();
    let changed = false;
    for (const property of MAILBOX_COUNT_PROPERTIES) {
      delta[property] = to[property] - from[property];
      if (delta[property] !== 0) changed = true;
    }
    if (changed) deltas.set(mailboxId, delta);
  }
  return deltas;
}

async function mailboxCountOps(
  ctx: MethodContext,
  deltas: Map<string, MailboxCounts>,
): Promise<WriteOp[]> {
  if (deltas.size === 0) return [];
  // Only to skip mailboxes that no longer exist; the counters themselves are incremented atomically.
  const existing = await ctx.store.get(ctx.auth.accountId, MAILBOX, [
    ...deltas.keys(),
  ]);

  return existing.map((record): WriteOp => {
    const delta = deltas.get(record.id) as MailboxCounts;
    return {
      kind: 'increment',
      type: MAILBOX,
      id: record.id,
      deltas: Object.fromEntries(
        MAILBOX_COUNT_PROPERTIES.filter(
          (property) => delta[property] !== 0,
        ).map((property) => [property, delta[property]]),
      ),
    };
  });
}

function sortedEmailIds(emails: Map<string, EmailValue>): string[] {
  return [...emails]
    .sort(([idA, a], [idB, b]) =>
      a.receivedAt < b.receivedAt
        ? -1
        : a.receivedAt > b.receivedAt
          ? 1
          : idA < idB
            ? -1
            : 1,
    )
    .map(([id]) => id);
}

export async function listThreadEmails(
  ctx: MethodContext,
  threadId: string,
): Promise<EmailRecord[]> {
  return (await ctx.store.list(ctx.auth.accountId, EMAIL, {
    name: 'thread',
    value: threadId,
  })) as unknown as EmailRecord[];
}

/**
 * The single write path for Email records. Changes to the emails of one thread
 * are committed together with the Thread object and the affected mailbox
 * counts, so the three never drift apart. `compute` sees the thread's current
 * emails and is re-run if another writer gets in first.
 */
export async function mutateThread(
  ctx: MethodContext,
  threadId: string,
  compute: (
    emails: EmailRecord[],
  ) => EmailMutation[] | Promise<EmailMutation[]>,
  /** Further writes for the same commit, made only when `compute` changes something. */
  alongside?: () => Promise<WriteOp[]>,
): Promise<void> {
  const accountId = ctx.auth.accountId;

  await retryOnConflict(async () => {
    const current = await listThreadEmails(ctx, threadId);
    const mutations = await compute(current);
    if (mutations.length === 0) return;

    const versions = new Map(
      current.map((record) => [record.id, record.version]),
    );
    const after = new Map(current.map((record) => [record.id, record.value]));
    const ops: WriteOp[] = [];

    for (const mutation of mutations) {
      if (mutation.kind === 'create') {
        after.set(mutation.id, mutation.value);
        ops.push({
          kind: 'create',
          type: EMAIL,
          id: mutation.id,
          value: asJson(mutation.value),
          indexes: emailIndexes(mutation.value),
        });
        if (mutation.text) ops.push(emailTextOp(mutation.id, mutation.text));
        continue;
      }

      const version = versions.get(mutation.id);
      if (version === undefined) {
        throw new ConflictError(`Email ${mutation.id} left thread ${threadId}`);
      }
      if (mutation.kind === 'update') {
        after.set(mutation.id, mutation.value);
        ops.push({
          kind: 'update',
          type: EMAIL,
          id: mutation.id,
          value: asJson(mutation.value),
          expectedVersion: version,
          indexes: emailIndexes(mutation.value),
          changedProperties: mutation.changedProperties,
        });
      } else {
        after.delete(mutation.id);
        ops.push({
          kind: 'destroy',
          type: EMAIL,
          id: mutation.id,
          expectedVersion: version,
        });
      }
    }

    const [thread] = (await ctx.store.get(accountId, THREAD, [
      threadId,
    ])) as unknown as ThreadRecord[];
    const emailIds = sortedEmailIds(after);
    if (emailIds.length === 0) {
      if (thread) {
        ops.push({
          kind: 'destroy',
          type: THREAD,
          id: threadId,
          expectedVersion: thread.version,
        });
      }
    } else if (!thread) {
      ops.push({
        kind: 'create',
        type: THREAD,
        id: threadId,
        value: { emailIds },
      });
    } else if (thread.value.emailIds.join() !== emailIds.join()) {
      ops.push({
        kind: 'update',
        type: THREAD,
        id: threadId,
        value: { emailIds },
        expectedVersion: thread.version,
        changedProperties: ['emailIds'],
      });
    }

    const deltas = countDeltas(
      threadContribution(current.map((record) => record.value)),
      threadContribution(after.values()),
    );
    ops.push(...(await mailboxCountOps(ctx, deltas)));
    // An email's searchable text goes when it does.
    ops.push(
      ...(await destroyTextOps(
        ctx,
        mutations.flatMap((mutation) =>
          mutation.kind === 'destroy' ? [mutation.id] : [],
        ),
      )),
    );
    // How much room the account's mail takes changes with it.
    const octets = (emails: Iterable<{ size: number }>) => {
      let total = 0;
      for (const email of emails) total += email.size;
      return total;
    };
    ops.push(
      ...(await usageOps(
        ctx,
        octets(after.values()) - octets(current.map((record) => record.value)),
      )),
    );
    if (alongside) ops.push(...(await alongside()));

    await commit(ctx, ops);
  });
}

export async function getEmail(
  ctx: MethodContext,
  id: string,
): Promise<EmailRecord | undefined> {
  const [record] = (await ctx.store.get(ctx.auth.accountId, EMAIL, [
    id,
  ])) as unknown as EmailRecord[];
  return record;
}

/** Destroys an email and its raw message. Returns false when it does not exist. */
export async function destroyEmail(
  ctx: MethodContext,
  id: string,
): Promise<boolean> {
  const record = await getEmail(ctx, id);
  if (!record) return false;

  let destroyed = false;
  await mutateThread(ctx, record.value.threadId, (emails) => {
    destroyed = emails.some((email) => email.id === id);
    return destroyed ? [{ kind: 'destroy', id }] : [];
  });
  if (destroyed) {
    await ctx.blobs.delete(ctx.auth.accountId, record.value.blobId);
  }
  return destroyed;
}

/** Takes an email out of one mailbox, destroying it when that was its last mailbox. */
export async function removeFromMailbox(
  ctx: MethodContext,
  emailId: string,
  mailboxId: string,
): Promise<void> {
  const record = await getEmail(ctx, emailId);
  if (!record) return;

  let blobToDelete: string | undefined;
  await mutateThread(ctx, record.value.threadId, (emails) => {
    blobToDelete = undefined;
    const current = emails.find((email) => email.id === emailId);
    if (!current || !current.value.mailboxIds[mailboxId]) return [];

    const mailboxIds = { ...current.value.mailboxIds };
    delete mailboxIds[mailboxId];
    if (Object.keys(mailboxIds).length === 0) {
      blobToDelete = current.value.blobId;
      return [{ kind: 'destroy', id: emailId }];
    }
    return [
      {
        kind: 'update',
        id: emailId,
        value: { ...current.value, mailboxIds },
        changedProperties: ['mailboxIds'],
      },
    ];
  });
  if (blobToDelete) await ctx.blobs.delete(ctx.auth.accountId, blobToDelete);
}
