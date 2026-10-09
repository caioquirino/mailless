/** RFC 8620 §1.2: 1-255 characters from the URL-safe base64 alphabet. */
export type Id = string;

/** RFC 8620 §1.4: RFC 3339 date-time with a "Z" time zone. */
export type UTCDate = string;

/** RFC 8620 §1.4: RFC 3339 date-time with any time zone offset. */
export type JmapDate = string;

export type Invocation = [
  name: string,
  args: Record<string, unknown>,
  callId: string,
];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<Id, Id>;
}

export interface JmapResponse {
  methodResponses: Invocation[];
  createdIds?: Record<Id, Id>;
  sessionState: string;
}

export interface ResultReference {
  resultOf: string;
  name: string;
  path: string;
}

export const CAPABILITY_CORE = 'urn:ietf:params:jmap:core';
export const CAPABILITY_MAIL = 'urn:ietf:params:jmap:mail';
export const CAPABILITY_SUBMISSION = 'urn:ietf:params:jmap:submission';
export const CAPABILITY_VACATION = 'urn:ietf:params:jmap:vacationresponse';
export const CAPABILITY_BLOB = 'urn:ietf:params:jmap:blob';
export const CAPABILITY_QUOTA = 'urn:ietf:params:jmap:quota';
export const CAPABILITY_MDN = 'urn:ietf:params:jmap:mdn';
export const CAPABILITY_PRINCIPALS = 'urn:ietf:params:jmap:principals';
export const CAPABILITY_PRINCIPALS_OWNER =
  'urn:ietf:params:jmap:principals:owner';
export const CAPABILITY_CONTACTS = 'urn:ietf:params:jmap:contacts';
/** JMAP for Calendars: calendars, and events as JSCalendar (RFC 8984). */
export const CAPABILITY_CALENDARS = 'urn:ietf:params:jmap:calendars';
/**
 * Not an RFC's: suggesting another time for an event one was invited to, and
 * saying no to such a suggestion (CalendarProposal/send, /decline). JMAP for
 * Calendars has the invitation and the answer, and not this.
 */
export const CAPABILITY_CALENDAR_PROPOSALS =
  'https://github.com/caioquirino/mailless/jmap/calendar-proposals';
export const CAPABILITY_WEBSOCKET = 'urn:ietf:params:jmap:websocket';
/**
 * Not an RFC's: the names and colours someone gives to keywords of their own
 * (Tag/get, Tag/changes, Tag/set). A client that does not know it never names it.
 */
export const CAPABILITY_TAGS =
  'https://github.com/caioquirino/mailless/jmap/tags';
/**
 * Not an RFC's: the addresses whose mail is filed as junk when it arrives
 * (BlockedSender/get, BlockedSender/changes, BlockedSender/set).
 */
export const CAPABILITY_BLOCKED_SENDERS =
  'https://github.com/caioquirino/mailless/jmap/blocked-senders';
/** RFC 9749: the key a client gives its push service, so that only this server may push to it. */
export const CAPABILITY_WEBPUSH_VAPID = 'urn:ietf:params:jmap:webpush-vapid';

export interface CoreCapability {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  collationAlgorithms: string[];
}

export interface MailAccountCapability {
  maxMailboxesPerEmail: number | null;
  maxMailboxDepth: number | null;
  maxSizeMailboxName: number;
  maxSizeAttachmentsPerEmail: number;
  emailQuerySortOptions: string[];
  mayCreateTopLevelMailbox: boolean;
}

export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

export interface UploadResponse {
  accountId: Id;
  blobId: Id;
  type: string;
  size: number;
}
