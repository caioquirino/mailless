/**
 * The server turned the whole request away, or could not be reached as a
 * JMAP server at all: a wrong sign-in, a request too large, a body that is
 * not JSON (RFC 8620 §3.6.1).
 */
export class JmapRequestError extends Error {
  constructor(
    /** The HTTP status. */
    readonly status: number,
    /** The problem type, such as `urn:ietf:params:jmap:error:limit`, or `about:blank`. */
    readonly type: string,
    detail: string,
    /** For a limit error, which limit. */
    readonly limit?: string,
  ) {
    super(detail);
    this.name = 'JmapRequestError';
  }
}

/** One method call of a batch failed (RFC 8620 §3.6.2). The others stand. */
export class JmapMethodError extends Error {
  constructor(
    /** The method that was called. */
    readonly method: string,
    /** The error type, such as `invalidArguments` or `accountNotFound`. */
    readonly type: string,
    /** Everything the server said about it. */
    readonly details: Record<string, unknown>,
  ) {
    super(
      typeof details['description'] === 'string'
        ? `${method}: ${type}: ${details['description']}`
        : `${method}: ${type}`,
    );
    this.name = 'JmapMethodError';
  }
}
