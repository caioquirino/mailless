import type { Id, JmapDate, UTCDate } from './types.js';

/** RFC 8621 §2 */
export type MailboxRole =
  | 'all'
  | 'archive'
  | 'drafts'
  | 'flagged'
  | 'important'
  | 'inbox'
  | 'junk'
  | 'sent'
  | 'subscribed'
  | 'trash'
  | (string & {});

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: MailboxRole | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

export interface MailboxFilterCondition {
  parentId?: Id | null;
  name?: string;
  role?: string | null;
  hasAnyRole?: boolean;
  isSubscribed?: boolean;
}

/** RFC 8621 §3 */
export interface Thread {
  id: Id;
  emailIds: Id[];
}

/** RFC 8621 §4 */
export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailAddressGroup {
  name: string | null;
  addresses: EmailAddress[];
}

export interface EmailHeader {
  name: string;
  value: string;
}

export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: number;
  headers: EmailHeader[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts: EmailBodyPart[] | null;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: UTCDate;
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
  sentAt: JmapDate | null;
  bodyStructure: EmailBodyPart;
  bodyValues: Record<string, EmailBodyValue>;
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  hasAttachment: boolean;
  preview: string;
}

export interface EmailFilterCondition {
  inMailbox?: Id;
  inMailboxOtherThan?: Id[];
  before?: UTCDate;
  after?: UTCDate;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: string[];
}

export interface EmailImport {
  blobId: Id;
  mailboxIds: Record<Id, true>;
  keywords?: Record<string, true>;
  receivedAt?: UTCDate;
}

/** RFC 8621 §6 */
export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

/** RFC 8621 §7 */
export interface SubmissionAddress {
  email: string;
  parameters: Record<string, string | null> | null;
}

export interface Envelope {
  mailFrom: SubmissionAddress;
  rcptTo: SubmissionAddress[];
}

export interface DeliveryStatus {
  smtpReply: string;
  delivered: 'queued' | 'yes' | 'no' | 'unknown';
  displayed: 'unknown' | 'yes';
}

export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  envelope: Envelope | null;
  sendAt: UTCDate;
  undoStatus: 'pending' | 'final' | 'canceled';
  deliveryStatus: Record<string, DeliveryStatus> | null;
  dsnBlobIds: Id[];
  mdnBlobIds: Id[];
}

/** System keywords from RFC 8621 §4.1.1. */
export const KEYWORD_DRAFT = '$draft';
export const KEYWORD_SEEN = '$seen';
export const KEYWORD_FLAGGED = '$flagged';
export const KEYWORD_ANSWERED = '$answered';
export const KEYWORD_FORWARDED = '$forwarded';

/** Properties returned by Email/get when `properties` is omitted (RFC 8621 §4.2). */
export const DEFAULT_EMAIL_PROPERTIES = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'size',
  'receivedAt',
  'messageId',
  'inReplyTo',
  'references',
  'sender',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'sentAt',
  'hasAttachment',
  'preview',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
] as const;

/** Body part properties returned when `bodyProperties` is omitted (RFC 8621 §4.2). */
export const DEFAULT_BODY_PROPERTIES = [
  'partId',
  'blobId',
  'size',
  'name',
  'type',
  'charset',
  'disposition',
  'cid',
  'language',
  'location',
] as const;
