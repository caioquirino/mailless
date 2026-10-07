import type { EmailAddress, EmailHeader } from '@mailless/jmap-core';
import type { IndexKeys, JsonObject, StoredRecord } from '../storage.js';

export const MAILBOX = 'Mailbox';
export const EMAIL = 'Email';
export const THREAD = 'Thread';

export const MAILBOX_COUNT_PROPERTIES = [
  'totalEmails',
  'unreadEmails',
  'totalThreads',
  'unreadThreads',
] as const;

export type MailboxCounts = Record<
  (typeof MAILBOX_COUNT_PROPERTIES)[number],
  number
>;

/** What is stored for a Mailbox; `id` is the record id and `myRights` is computed. */
export type MailboxValue = MailboxCounts & {
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
  isSubscribed: boolean;
};

export type ThreadValue = { emailIds: string[] };

export type StoredBodyPart = {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  subParts: StoredBodyPart[] | null;
};

/** Email metadata kept in the metadata store. Body content stays in the raw message blob. */
export type EmailValue = {
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: string;
  headers: EmailHeader[];
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: EmailAddress[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  bodyStructure: StoredBodyPart;
  /**
   * Ids the transport gave this message when it was sent, in place of its own
   * Message-ID. Not shown to clients; used so that replies find their thread.
   */
  transportMessageIds?: string[];
  /** Part ids, resolved against bodyStructure when read. */
  textBody: string[];
  htmlBody: string[];
  attachments: string[];
};

export type MailboxRecord = StoredRecord<MailboxValue>;
export type EmailRecord = StoredRecord<EmailValue>;
export type ThreadRecord = StoredRecord<ThreadValue>;

export function asJson(value: object): JsonObject {
  return value as JsonObject;
}

const MAX_THREAD_KEYS = 16;

/**
 * Message ids that tie an email to a conversation: its own, what it replies
 * to, and the most recent references. Capped so one email never needs an
 * unbounded number of index entries.
 */
export function threadKeys(value: {
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  transportMessageIds?: string[];
}): string[] {
  return [
    ...new Set([
      ...(value.messageId ?? []),
      ...(value.transportMessageIds ?? []),
      ...(value.inReplyTo ?? []),
      ...[...(value.references ?? [])].reverse(),
    ]),
  ].slice(0, MAX_THREAD_KEYS);
}

export function emailIndexes(value: EmailValue): IndexKeys {
  return {
    mailbox: Object.keys(value.mailboxIds),
    thread: [value.threadId],
    threadKey: threadKeys(value),
  };
}

/** Subject with reply/forward prefixes and whitespace removed, for thread matching (RFC 8621 §3). */
export function baseSubject(subject: string | null): string {
  let result = (subject ?? '').trim();
  for (;;) {
    const stripped = result.replace(
      /^(re|fwd?|aw|wg)\s*(\[\d+\])?\s*:\s*/i,
      '',
    );
    if (stripped === result) break;
    result = stripped;
  }
  return result.replace(/\s+/g, ' ').toLowerCase();
}

const KEYWORD = /^[\x21-\x7e]{1,255}$/;
const KEYWORD_FORBIDDEN = /[(){\]%*"\\]/;

export function isValidKeyword(keyword: string): boolean {
  return (
    KEYWORD.test(keyword) &&
    !KEYWORD_FORBIDDEN.test(keyword) &&
    keyword === keyword.toLowerCase()
  );
}

export function isUnread(keywords: Record<string, true>): boolean {
  return !keywords['$seen'] && !keywords['$draft'];
}
