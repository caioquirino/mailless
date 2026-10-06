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
export const CAPABILITY_WEBSOCKET = 'urn:ietf:params:jmap:websocket';

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
