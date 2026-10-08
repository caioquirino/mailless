import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  type Id,
  type Invocation,
  type JmapResponse,
  type ResultReference,
  type Session,
  type UploadResponse,
} from '@mailless/jmap-core';
import { capabilitiesFor, capabilityOf } from './capabilities.js';
import { JmapMethodError, JmapRequestError } from './errors.js';
import type { ArgumentsOf, MethodMap, ResponseOf } from './methods.js';

export interface JmapClientOptions {
  /**
   * Where the server describes itself: `https://mail.example.com/.well-known/jmap`.
   * Everything else (where to send calls, upload and download) is read from there.
   */
  sessionUrl: string;
  /**
   * The `Authorization` header to send, such as `Bearer <token>` or
   * `Basic <base64>`. A function is asked before every request, which is
   * where a token that expires is renewed.
   */
  authorization: string | (() => string | Promise<string>);
  /** The `fetch` to use. Defaults to the global one. */
  fetch?: typeof fetch;
}

export interface BatchOptions {
  /**
   * The capabilities the request says it uses. Worked out from the methods
   * called when left out, which works for the methods this package knows.
   */
  using?: string[];
  /**
   * The account for calls that do not name one. Defaults to the user's
   * primary account for what each method is about.
   */
  accountId?: Id;
}

/** One method call in a batch: something later calls can refer to, and the key to its response. */
export interface Call<Name extends string = string> {
  readonly id: string;
  readonly name: Name;
  /**
   * A reference to part of this call's result, for an argument of a later
   * call in the same batch: `{ '#ids': query.ref('/ids') }` (RFC 8620 §3.7).
   */
  ref(path: string): ResultReference;
}

/** Methods that are about the user, not about one of their accounts. */
const WITHOUT_ACCOUNT = /^(Core\/echo|PushSubscription\/)/;

/** What the server answered to a batch. */
export class BatchResult {
  constructor(
    /** Every response, in order, as the server sent them. */
    readonly responses: readonly Invocation[],
    /** The ids the server gave to what the batch created, by creation id. */
    readonly createdIds: Readonly<Record<Id, Id>>,
    readonly sessionState: string,
  ) {}

  /** Every response to a call. A call usually has one; some methods answer with more. */
  all(call: Call): Invocation[] {
    return this.responses.filter(([, , id]) => id === call.id);
  }

  /**
   * The response to a call. Throws `JmapMethodError` when the call failed,
   * which leaves the rest of the batch as it is.
   */
  get<Name extends string>(call: Call<Name>): ResponseOf<Name> {
    const responses = this.all(call);
    const failure = responses.find(([name]) => name === 'error');
    const response =
      responses.find(([name]) => name === call.name) ?? responses[0];
    if (failure && (!response || response === failure)) {
      const details = failure[1];
      throw new JmapMethodError(
        call.name,
        typeof details['type'] === 'string' ? details['type'] : 'serverFail',
        details,
      );
    }
    if (!response) {
      throw new JmapMethodError(call.name, 'serverFail', {
        description: 'The server did not answer this call',
      });
    }
    return response[1] as ResponseOf<Name>;
  }

  /** Whether a call succeeded, for when a failure is something to act on and not an exception. */
  ok(call: Call): boolean {
    return this.all(call).some(([name]) => name === call.name);
  }
}

/** Method calls collected to be sent as one request, and run by the server in order. */
export class Batch {
  private readonly calls: Array<{
    name: string;
    args: Record<string, unknown>;
    id: string;
  }> = [];

  constructor(
    private readonly client: JmapClient,
    private readonly options: BatchOptions,
  ) {}

  call<Name extends keyof MethodMap>(
    name: Name,
    args: ArgumentsOf<Name>,
  ): Call<Name>;
  call<Name extends string>(
    name: Name,
    args: Record<string, unknown>,
  ): Call<Name>;
  call(name: string, args: object): Call {
    const id = `c${this.calls.length}`;
    this.calls.push({ name, args: { ...args }, id });
    return { id, name, ref: (path) => ({ resultOf: id, name, path }) };
  }

  /** Sends what was collected. Throws `JmapRequestError` when the server refuses the request as a whole. */
  async send(): Promise<BatchResult> {
    if (this.calls.length === 0) {
      throw new Error('There is nothing to send: the batch has no calls');
    }
    const session = await this.client.session();
    const using =
      this.options.using ??
      capabilitiesFor(this.calls.map((call) => call.name));

    const methodCalls = this.calls.map(({ name, args, id }): Invocation => {
      if (
        'accountId' in args ||
        '#accountId' in args ||
        WITHOUT_ACCOUNT.test(name)
      ) {
        return [name, args, id];
      }
      const accountId =
        this.options.accountId ??
        session.primaryAccounts[capabilityOf(name) ?? ''] ??
        session.primaryAccounts[CAPABILITY_MAIL] ??
        session.primaryAccounts[CAPABILITY_CORE];
      if (!accountId) {
        throw new Error(
          `${name} needs an accountId, and the session names no primary account for it`,
        );
      }
      return [name, { accountId, ...args }, id];
    });

    const response = await this.client.post(session.apiUrl, {
      using,
      methodCalls,
    });
    return new BatchResult(
      response.methodResponses,
      response.createdIds ?? {},
      response.sessionState,
    );
  }
}

async function refusal(response: Response): Promise<JmapRequestError> {
  let problem: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null) {
      problem = parsed as Record<string, unknown>;
    }
  } catch {
    // Not every failure comes from a JMAP server: a proxy answers in its own way.
  }
  return new JmapRequestError(
    response.status,
    typeof problem['type'] === 'string' ? problem['type'] : 'about:blank',
    typeof problem['detail'] === 'string'
      ? problem['detail']
      : `The server answered ${response.status}`,
    typeof problem['limit'] === 'string' ? problem['limit'] : undefined,
  );
}

/** Fills a URL template of the session (RFC 6570, level 1) with values. */
function expand(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) =>
    name in values ? encodeURIComponent(values[name] as string) : whole,
  );
}

export class JmapClient {
  private readonly fetch: typeof fetch;
  private cached: Promise<Session> | undefined;

  constructor(private readonly options: JmapClientOptions) {
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  private async headers(extra: Record<string, string> = {}): Promise<Headers> {
    const { authorization } = this.options;
    return new Headers({
      authorization:
        typeof authorization === 'string'
          ? authorization
          : await authorization(),
      ...extra,
    });
  }

  /**
   * What the server says about itself and the user: accounts, limits and
   * where things are. Asked once and kept; asked again after the server
   * says it changed, or with `refresh`.
   */
  session(options: { refresh?: boolean } = {}): Promise<Session> {
    if (options.refresh) this.cached = undefined;
    if (!this.cached) {
      const fetched = (async () => {
        const response = await this.fetch(this.options.sessionUrl, {
          headers: await this.headers({ accept: 'application/json' }),
        });
        if (!response.ok) throw await refusal(response);
        return (await response.json()) as Session;
      })();
      this.cached = fetched;
      // A failure is not kept: the next call asks again.
      fetched.catch(() => {
        if (this.cached === fetched) this.cached = undefined;
      });
    }
    return this.cached;
  }

  /** The account the user's own data of some kind is in. Mail, unless another capability is named. */
  async accountId(capability: string = CAPABILITY_MAIL): Promise<Id> {
    const session = await this.session();
    const accountId = session.primaryAccounts[capability];
    if (!accountId) {
      throw new Error(`The user has no primary account for ${capability}`);
    }
    return accountId;
  }

  /** @internal Sends one JMAP request. Use `batch` or `call`. */
  async post(
    apiUrl: string,
    body: { using: string[]; methodCalls: Invocation[] },
  ): Promise<JmapResponse> {
    const response = await this.fetch(apiUrl, {
      method: 'POST',
      headers: await this.headers({
        'content-type': 'application/json',
        accept: 'application/json',
      }),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await refusal(response);
    const answer = (await response.json()) as JmapResponse;
    // Accounts or capabilities changed: what is kept is out of date.
    const known = await this.cached?.catch(() => undefined);
    if (known && known.state !== answer.sessionState) this.cached = undefined;
    return answer;
  }

  /** Starts a batch: several calls sent as one request. */
  batch(options: BatchOptions = {}): Batch {
    return new Batch(this, options);
  }

  /** One call on its own. Throws `JmapMethodError` when it fails. */
  async call<Name extends keyof MethodMap>(
    name: Name,
    args: ArgumentsOf<Name>,
    options?: BatchOptions,
  ): Promise<ResponseOf<Name>>;
  async call(
    name: string,
    args: Record<string, unknown>,
    options?: BatchOptions,
  ): Promise<Record<string, unknown>>;
  async call(
    name: string,
    args: object,
    options: BatchOptions = {},
  ): Promise<unknown> {
    const batch = this.batch(options);
    const call = batch.call(name, args as Record<string, unknown>);
    return (await batch.send()).get(call);
  }

  /** Stores content on the server and returns the blob it became, to attach to a message or import. */
  async upload(
    data: Uint8Array | Blob | string,
    options: { type: string; accountId?: Id },
  ): Promise<UploadResponse> {
    const session = await this.session();
    const accountId = options.accountId ?? (await this.accountId());
    const response = await this.fetch(
      expand(session.uploadUrl, { accountId }),
      {
        method: 'POST',
        headers: await this.headers({
          'content-type': options.type,
          accept: 'application/json',
        }),
        body: data as RequestInit['body'],
      },
    );
    if (!response.ok) throw await refusal(response);
    return (await response.json()) as UploadResponse;
  }

  /**
   * The content of a blob: a raw message, an attachment. `name` and `type`
   * are what the server calls the download and serves it as.
   */
  async download(
    blobId: Id,
    options: { accountId?: Id; name?: string; type?: string } = {},
  ): Promise<Uint8Array> {
    const session = await this.session();
    const response = await this.fetch(
      expand(session.downloadUrl, {
        accountId: options.accountId ?? (await this.accountId()),
        blobId,
        name: options.name ?? 'blob',
        type: options.type ?? 'application/octet-stream',
      }),
      { headers: await this.headers() },
    );
    if (!response.ok) throw await refusal(response);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export function createJmapClient(options: JmapClientOptions): JmapClient {
  return new JmapClient(options);
}
