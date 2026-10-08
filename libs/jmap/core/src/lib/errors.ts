/** Request-level problem types, RFC 8620 §3.6.1. */
export const REQUEST_ERROR = {
  unknownCapability: 'urn:ietf:params:jmap:error:unknownCapability',
  notJSON: 'urn:ietf:params:jmap:error:notJSON',
  notRequest: 'urn:ietf:params:jmap:error:notRequest',
  limit: 'urn:ietf:params:jmap:error:limit',
} as const;

/** `about:blank` is the RFC 7807 default, for plain HTTP failures such as 404 on a blob. */
export type RequestErrorType =
  (typeof REQUEST_ERROR)[keyof typeof REQUEST_ERROR] | 'about:blank';

export interface ProblemDetails {
  type: string;
  status: number;
  detail: string;
  limit?: string;
}

/** The whole request was rejected; hosts answer with `application/problem+json`. */
export class RequestError extends Error {
  readonly type: RequestErrorType;
  readonly status: number;
  readonly limit?: string;

  constructor(
    type: RequestErrorType,
    detail: string,
    options: { status?: number; limit?: string } = {},
  ) {
    super(detail);
    this.name = 'RequestError';
    this.type = type;
    this.status = options.status ?? 400;
    this.limit = options.limit;
  }

  toProblemDetails(): ProblemDetails {
    return {
      type: this.type,
      status: this.status,
      detail: this.message,
      ...(this.limit === undefined ? {} : { limit: this.limit }),
    };
  }
}

/** Method-level error types from RFC 8620 §3.6.2 and the standard methods in §5. */
export type MethodErrorType =
  | 'serverUnavailable'
  | 'serverFail'
  | 'serverPartialFail'
  | 'unknownMethod'
  | 'invalidArguments'
  | 'invalidResultReference'
  | 'forbidden'
  | 'accountNotFound'
  | 'accountNotSupportedByMethod'
  | 'accountReadOnly'
  | 'requestTooLarge'
  | 'cannotCalculateChanges'
  | 'stateMismatch'
  | 'anchorNotFound'
  | 'unsupportedSort'
  | 'unsupportedFilter'
  | 'tooManyChanges'
  | 'fromAccountNotFound'
  | 'fromAccountNotSupportedByMethod'
  | (string & {});

/** A single method call failed; it becomes an `["error", {...}, callId]` response. */
export class MethodError extends Error {
  readonly type: MethodErrorType;
  readonly extra: Record<string, unknown>;

  constructor(
    type: MethodErrorType,
    description?: string,
    extra: Record<string, unknown> = {},
  ) {
    super(description ?? type);
    this.name = 'MethodError';
    this.type = type;
    this.extra = extra;
  }

  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      ...(this.message === this.type ? {} : { description: this.message }),
      ...this.extra,
    };
  }
}

/** SetError types from RFC 8620 §5.3 and RFC 8621. */
export type SetErrorType =
  | 'forbidden'
  | 'overQuota'
  | 'tooLarge'
  | 'rateLimit'
  | 'notFound'
  | 'invalidPatch'
  | 'willDestroy'
  | 'invalidProperties'
  | 'singleton'
  | 'alreadyExists'
  | 'mailboxHasChild'
  | 'mailboxHasEmail'
  | 'blobNotFound'
  | 'tooManyKeywords'
  | 'tooManyMailboxes'
  | 'invalidEmail'
  | (string & {});

export interface SetError {
  type: SetErrorType;
  description?: string;
  properties?: string[];
  [key: string]: unknown;
}

/** One object in a `/set`-style call was rejected; the rest of the call continues. */
export class SetFailure extends Error {
  readonly error: SetError;

  constructor(
    type: SetErrorType,
    description?: string,
    extra: Record<string, unknown> = {},
  ) {
    super(description ?? type);
    this.name = 'SetFailure';
    this.error = {
      type,
      ...(description === undefined ? {} : { description }),
      ...extra,
    };
  }
}
