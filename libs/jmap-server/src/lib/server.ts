import {
  CAPABILITY_BLOB,
  CAPABILITY_CONTACTS,
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_MDN,
  CAPABILITY_PRINCIPALS,
  CAPABILITY_PRINCIPALS_OWNER,
  CAPABILITY_QUOTA,
  CAPABILITY_SUBMISSION,
  CAPABILITY_VACATION,
  IdSchema,
  MethodError,
  REQUEST_ERROR,
  RequestError,
  RequestSchema,
  resolveResultReferences,
  type CoreCapability,
  type Invocation,
  type JmapResponse,
  type MailAccountCapability,
  type Session,
  type UploadResponse,
} from '@mailless/jmap-core';
import { z } from 'zod';
import {
  generateId,
  parseArguments,
  requireCopyAccounts,
  type AuthContext,
  type MethodContext,
  type MethodDefinition,
  type ResolvedIdentity,
} from './context.js';
import {
  EMAIL_SORT_OPTIONS,
  emailMethods,
  importMessage,
  readBlob,
  type ImportedEmail,
  type ImportOptions,
} from './mail/email.js';
import {
  mailboxMethods,
  MAX_MAILBOX_DEPTH,
  provisionMailboxes,
} from './mail/mailbox.js';
import {
  IDENTITY_SETTINGS,
  recordDelivery,
  sendScheduled,
  submissionMethods,
  type DeliveryUpdate,
  type ScheduledSendOutcome,
} from './mail/submission.js';
import {
  blobMethods,
  DIGEST_ALGORITHMS,
  LOOKUP_TYPES,
  MAX_DATA_SOURCES,
} from './blob/blob.js';
import { mdnMethods } from './mail/mdn.js';
import { threadMethods } from './mail/thread.js';
import { contactMethods, provisionAddressBooks } from './contacts/contacts.js';
import { principalMethods } from './principals.js';
import { quotaMethods } from './quota.js';
import { vacationMethods } from './mail/vacation.js';
import {
  pushMethods,
  pushMethodsWhenDisabled,
  pushStateChange,
  resolvePushOptions,
  type PushOptions,
  type PushReport,
} from './push/subscription.js';
import { COLLATIONS } from './standard/query.js';
import {
  StateMismatchError,
  type BlobStore,
  type MetadataStore,
  type StorageAdapter,
} from './storage.js';
import type { MailTransport, SendScheduler } from './transport.js';

export const DEFAULT_LIMITS: CoreCapability = {
  maxSizeUpload: 50_000_000,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  collationAlgorithms: COLLATIONS,
};

export interface JmapServerUrls {
  api: string;
  /** Must contain `{accountId}`, `{blobId}`, `{name}` and `{type}`. */
  download: string;
  /** Must contain `{accountId}`. */
  upload: string;
  eventSource: string;
}

export interface JmapServerOptions {
  storage: StorageAdapter;
  urls: JmapServerUrls;
  limits?: Partial<CoreCapability>;
  /** Called with errors that were reported to the client only as `serverFail`. */
  onError?: (error: unknown, method: string) => void;
  /**
   * Called when a method call is answered with an error such as
   * `unknownMethod` or `invalidArguments`. Useful for seeing what clients ask
   * for that the server does not do.
   */
  onMethodError?: (method: string, type: string, description?: string) => void;
  /**
   * Called once per request with what was asked and how each call fared:
   * method names and outcome types only, never arguments or results. Meant
   * for logs that show how clients use the server.
   */
  onRequest?: (summary: RequestSummary) => void;
  /**
   * How outgoing mail leaves. When set, the server offers the submission
   * capability (Identity and EmailSubmission methods).
   */
  transport?: MailTransport;
  /**
   * A limit on how much mail an account may hold, in octets. With one, the
   * account has a quota that clients can show. Mail arriving from outside is
   * never refused for it; what the user adds themself is.
   */
  quota?: { maxOctets: number };
  /**
   * What `isSubscribed` is on a mailbox created without saying, including the
   * standard ones. Default false, as other JMAP servers have it. Set it to
   * true for mail apps that show only subscribed mailboxes.
   */
  subscribeNewMailboxes?: boolean;
  /**
   * By default a reply joins the thread of the message it answers, whatever
   * its subject. With this, it must also keep the subject (ignoring "Re:" and
   * the like), so that a reply written to start a new topic gets a thread of
   * its own, as RFC 8621 §3 recommends.
   */
  threadsRequireSameSubject?: boolean;
  /**
   * Lets clients ask for a message to be sent later, and cancel it until
   * then. The scheduler must see to it that `sendScheduled` is called when
   * the time comes.
   */
  scheduler?: SendScheduler;
  /** The longest a message may be held, in seconds. Default 30 days. */
  maxDelayedSend?: number;
  /**
   * The addresses an account may send from. An email of `*@example.com`
   * allows any address at that domain.
   */
  identities?: (
    auth: AuthContext,
  ) => IdentityInput[] | Promise<IdentityInput[]>;
  /**
   * Called for each delivered message with what became of the account's
   * vacation response: `sent`, `failed` (with the error), or the reason none
   * was due, such as `disabled` or `mailing-list`. For logs; it carries no
   * addresses.
   */
  onAutoReply?: (outcome: string, error?: unknown) => void;
  /**
   * Lets clients register push subscriptions (RFC 8620 §7.2). The server then
   * makes HTTPS requests to URLs that clients name, so this is off unless
   * asked for. Pushes go out when `pushStateChange` is called.
   */
  push?: PushOptions;
  /**
   * Called after every write the server makes, with the data types whose
   * state moved. A host that runs as one process can call `pushStateChange`
   * from here; others learn of changes from their database instead.
   */
  onStateChange?: (accountId: string, types: string[]) => void;
}

export interface RequestSummary {
  /** The methods called, in order. */
  calls: string[];
  /**
   * The outcome of each response, in order: the method name, `error:<type>`,
   * or for `/set` responses with rejected objects, the name followed by the
   * distinct SetError types, such as `Email/set!forbidden`.
   */
  results: string[];
}

export interface IdentityInput {
  id: string;
  /**
   * The address clients offer as the sender. Use a real address here: clients
   * put it in the From header as it is.
   */
  email: string;
  name?: string;
  /**
   * Further addresses this identity may send as, without listing each as an
   * identity. `*@example.com` allows any address at that domain.
   */
  allowedFrom?: string[];
}

export interface JmapServer {
  /** The limits in force, as advertised in the session. */
  readonly limits: CoreCapability;
  getSession(auth: AuthContext): Session;
  /** Runs a parsed JMAP request. Throws RequestError when the request as a whole is rejected. */
  handleRequest(request: unknown, auth: AuthContext): Promise<JmapResponse>;
  upload(
    auth: AuthContext,
    accountId: string,
    data: Uint8Array,
    type: string,
  ): Promise<UploadResponse>;
  /** Returns null when the account or blob does not exist. */
  download(
    auth: AuthContext,
    accountId: string,
    blobId: string,
  ): Promise<Uint8Array | null>;
  /** Stores a raw message as an Email, for inbound delivery. */
  importMessage(
    auth: AuthContext,
    raw: Uint8Array,
    options: ImportOptions,
  ): Promise<ImportedEmail>;
  /** Creates the standard mailboxes for an account that has none. */
  provisionAccount(auth: AuthContext): Promise<void>;
  /**
   * Records what became of a sent message for some of its recipients, as
   * learned from the transport later (delivered, bounced, delayed). Returns
   * false when the submission does not exist.
   */
  recordDelivery(
    auth: AuthContext,
    submissionId: string,
    updates: Record<string, DeliveryUpdate>,
  ): Promise<boolean>;
  /**
   * Sends a message that was being held, now that its time has come. Called
   * by whatever the `scheduler` option arranged. Calling it twice, or for a
   * message that was cancelled, does nothing. Throws when sending failed in a
   * way worth trying again.
   */
  sendScheduled(
    auth: AuthContext,
    submissionId: string,
  ): Promise<ScheduledSendOutcome>;
  /**
   * Tells the account's push subscriptions that data changed. `types` names
   * the data types that changed; without it, all are reported. Does nothing
   * when push is not configured. Failures to reach a push service are counted
   * in the result, not thrown.
   */
  pushStateChange(
    accountId: string,
    types?: readonly string[],
  ): Promise<PushReport>;
  registerMethod(name: string, definition: MethodDefinition): void;
}

const STATE_PREFIX = 's';

/**
 * Gives state strings a letter in front. A store may well call its first
 * state "0" or "", which is a fine state and a poor thing to hand to clients:
 * more than one treats such a value as "no state yet".
 */
function publicStates(store: MetadataStore): MetadataStore {
  const inner = (state: string): string | null =>
    state.startsWith(STATE_PREFIX) ? state.slice(STATE_PREFIX.length) : null;
  return {
    get: (accountId, type, ids) => store.get(accountId, type, ids),
    list: (accountId, type, index) => store.list(accountId, type, index),
    getState: async (accountId, type) =>
      STATE_PREFIX + (await store.getState(accountId, type)),
    async getChanges(accountId, type, sinceState) {
      const since = inner(sinceState);
      if (since === null) return null;
      const entries = await store.getChanges(accountId, type, since);
      return (
        entries?.map((entry) => ({
          ...entry,
          state: STATE_PREFIX + entry.state,
        })) ?? null
      );
    },
    async commit(accountId, ops, commitOptions) {
      const expected = commitOptions?.expectedStates;
      if (!expected) return store.commit(accountId, ops, commitOptions);
      const expectedStates: Record<string, string> = {};
      for (const [type, state] of Object.entries(expected)) {
        const since = inner(state);
        if (since === null) {
          throw new StateMismatchError(`${type} is not at state ${state}`);
        }
        expectedStates[type] = since;
      }
      return store.commit(accountId, ops, { ...commitOptions, expectedStates });
    },
  };
}

/** Wraps a store so that every successful commit is reported. */
function reportingCommits(
  store: MetadataStore,
  onStateChange: (accountId: string, types: string[]) => void,
): MetadataStore {
  return {
    getState: (accountId, type) => store.getState(accountId, type),
    get: (accountId, type, ids) => store.get(accountId, type, ids),
    list: (accountId, type, index) => store.list(accountId, type, index),
    getChanges: (accountId, type, sinceState) =>
      store.getChanges(accountId, type, sinceState),
    async commit(accountId, ops, commitOptions) {
      await store.commit(accountId, ops, commitOptions);
      if (ops.length === 0) return;
      try {
        onStateChange(accountId, [...new Set(ops.map((op) => op.type))]);
      } catch {
        // The write happened; a failing listener must not make it look otherwise.
      }
    },
  };
}

function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16);
}

export function createJmapServer(options: JmapServerOptions): JmapServer {
  const limits: CoreCapability = { ...DEFAULT_LIMITS, ...options.limits };
  // A message can be held only where something will wake up to send it.
  const maxDelayedSend = options.scheduler
    ? (options.maxDelayedSend ?? 30 * 24 * 60 * 60)
    : 0;
  const submissionCapability = {
    maxDelayedSend,
    submissionExtensions:
      maxDelayedSend > 0 ? { FUTURERELEASE: [String(maxDelayedSend)] } : {},
  };
  const canSend = options.transport !== undefined;
  const capabilities: Record<string, unknown> = {
    [CAPABILITY_CORE]: limits,
    [CAPABILITY_MAIL]: {},
    [CAPABILITY_BLOB]: {},
    [CAPABILITY_QUOTA]: {},
    [CAPABILITY_PRINCIPALS]: {},
    [CAPABILITY_CONTACTS]: {},
    ...(canSend
      ? {
          [CAPABILITY_SUBMISSION]: submissionCapability,
          // Offered with sending: a vacation response and a read receipt are messages sent.
          [CAPABILITY_VACATION]: {},
          [CAPABILITY_MDN]: {},
        }
      : {}),
  };
  const mailAccountCapability: MailAccountCapability = {
    maxMailboxesPerEmail: null,
    maxMailboxDepth: MAX_MAILBOX_DEPTH,
    maxSizeMailboxName: 255,
    maxSizeAttachmentsPerEmail: limits.maxSizeUpload,
    emailQuerySortOptions: EMAIL_SORT_OPTIONS,
    mayCreateTopLevelMailbox: true,
  };
  const accountCapabilities = {
    [CAPABILITY_CORE]: {},
    [CAPABILITY_MAIL]: mailAccountCapability,
    [CAPABILITY_BLOB]: {
      maxSizeBlobSet: limits.maxSizeUpload,
      maxDataSources: MAX_DATA_SOURCES,
      supportedTypeNames: LOOKUP_TYPES,
      supportedDigestAlgorithms: DIGEST_ALGORITHMS,
    },
    [CAPABILITY_QUOTA]: {},
    ...(canSend
      ? {
          [CAPABILITY_SUBMISSION]: submissionCapability,
          [CAPABILITY_VACATION]: {},
          [CAPABILITY_MDN]: {},
        }
      : {}),
  };
  /** An account as the session describes it to this user. */
  const describeAccount = (
    user: AuthContext,
    accountId: string,
  ): Record<string, unknown> | undefined => {
    const access = accessTo(user, accountId);
    if (!access) return undefined;
    return {
      name: access.name,
      isPersonal: access.isPersonal,
      isReadOnly: access.isReadOnly,
      accountCapabilities: {
        ...accountCapabilities,
        [CAPABILITY_CONTACTS]: {
          maxAddressBooksPerCard: null,
          mayCreateAddressBook: !access.isReadOnly,
        },
        // The principals are kept in the user's own account.
        ...(accountId === user.accountId
          ? {
              [CAPABILITY_PRINCIPALS]: {
                currentUserPrincipalId: user.accountId,
              },
            }
          : {}),
        // Each account belongs to the principal of the same id.
        [CAPABILITY_PRINCIPALS_OWNER]: {
          accountIdForPrincipal: user.accountId,
          principalId: accountId,
        },
      },
    };
  };
  const sessionState = hash(
    JSON.stringify([capabilities, accountCapabilities, options.urls]),
  );

  const states = publicStates(options.storage.metadata);
  const metadata = options.onStateChange
    ? reportingCommits(states, options.onStateChange)
    : states;

  /** The session changes when the server's abilities do, or the accounts a user may use. */
  const sessionStateFor = (auth: AuthContext): string =>
    auth.sharedAccounts && Object.keys(auth.sharedAccounts).length > 0
      ? hash(sessionState + JSON.stringify(auth.sharedAccounts))
      : sessionState;

  const methods = new Map<string, MethodDefinition>();
  methods.set('Core/echo', {
    capability: CAPABILITY_CORE,
    handler: async (args) => args,
  });
  methods.set('Blob/copy', {
    capability: CAPABILITY_CORE,
    handler: async (args, ctx) => {
      const { fromAccountId, accountId, blobIds } = parseArguments(
        z.strictObject({
          fromAccountId: z.string(),
          accountId: z.string(),
          blobIds: z.array(z.string()),
        }),
        args,
      );
      const { from, to } = requireCopyAccounts(ctx, fromAccountId, accountId);
      const ids = [...new Set(blobIds)];
      if (ids.length > limits.maxObjectsInSet) {
        throw new MethodError(
          'requestTooLarge',
          `At most ${limits.maxObjectsInSet} blobs may be copied in one call`,
        );
      }
      const copied: Record<string, string> = {};
      const notCopied: Record<string, { type: string }> = {};
      for (const blobId of ids) {
        const data = IdSchema.safeParse(blobId).success
          ? await readBlob(from, blobId)
          : null;
        if (!data) {
          notCopied[blobId] = { type: 'notFound' };
          continue;
        }
        const copy = generateId('bu');
        await to.blobs.put(accountId, copy, data);
        copied[blobId] = copy;
      }
      return {
        fromAccountId,
        accountId,
        copied: Object.keys(copied).length > 0 ? copied : null,
        notCopied: Object.keys(notCopied).length > 0 ? notCopied : null,
      };
    },
  });
  const push = options.push ? resolvePushOptions(options.push) : undefined;
  for (const [name, handler] of Object.entries(
    push ? pushMethods(push) : pushMethodsWhenDisabled,
  )) {
    methods.set(name, { capability: CAPABILITY_CORE, handler });
  }

  for (const group of [mailboxMethods, emailMethods, threadMethods]) {
    for (const [name, handler] of Object.entries(group)) {
      methods.set(name, { capability: CAPABILITY_MAIL, handler });
    }
  }
  for (const [capability, group] of [
    [CAPABILITY_BLOB, blobMethods],
    [CAPABILITY_QUOTA, quotaMethods],
    [CAPABILITY_PRINCIPALS, principalMethods],
    [CAPABILITY_CONTACTS, contactMethods],
    ...(canSend ? ([[CAPABILITY_MDN, mdnMethods]] as const) : []),
  ] as const) {
    for (const [name, handler] of Object.entries(group)) {
      methods.set(name, { capability, handler });
    }
  }
  if (canSend) {
    for (const [name, handler] of Object.entries(submissionMethods)) {
      methods.set(name, { capability: CAPABILITY_SUBMISSION, handler });
    }
    for (const [name, handler] of Object.entries(vacationMethods)) {
      methods.set(name, { capability: CAPABILITY_VACATION, handler });
    }
  }

  /** A store that refuses to write, for an account the user may only read. */
  const readOnly = (store: MetadataStore): MetadataStore => ({
    getState: (accountId, type) => store.getState(accountId, type),
    get: (accountId, type, ids) => store.get(accountId, type, ids),
    list: (accountId, type, index) => store.list(accountId, type, index),
    getChanges: (accountId, type, sinceState) =>
      store.getChanges(accountId, type, sinceState),
    commit: async () => {
      throw new MethodError('accountReadOnly');
    },
  });
  const readOnlyBlobs = (blobs: BlobStore): BlobStore => ({
    get: (accountId, blobId) => blobs.get(accountId, blobId),
    put: async () => {
      throw new MethodError('accountReadOnly');
    },
    delete: async () => {
      throw new MethodError('accountReadOnly');
    },
  });

  /**
   * The user's access to an account: their own, or one shared with them.
   * Undefined for any other account, whether or not it exists.
   */
  const accessTo = (
    user: AuthContext,
    accountId: string,
  ): { isReadOnly: boolean; name: string; isPersonal: boolean } | undefined => {
    if (accountId === user.accountId) {
      return { isReadOnly: false, name: user.username, isPersonal: true };
    }
    const shared = Object.prototype.hasOwnProperty.call(
      user.sharedAccounts ?? {},
      accountId,
    )
      ? user.sharedAccounts?.[accountId]
      : undefined;
    return shared
      ? {
          isReadOnly: shared.isReadOnly === true,
          name: shared.name ?? accountId,
          isPersonal: false,
        }
      : undefined;
  };

  /**
   * The context for one account of a user. Every method works on
   * `ctx.auth.accountId`, so pointing that at a shared account is all it
   * takes for a method to act there.
   */
  const makeContext = (
    user: AuthContext,
    accountId: string = user.accountId,
    createdIds: Map<string, string> = new Map(),
  ): MethodContext => {
    const access = accessTo(user, accountId);
    const auth: AuthContext = { accountId, username: user.username };
    return {
      auth,
      store: access?.isReadOnly ? readOnly(metadata) : metadata,
      blobs: access?.isReadOnly
        ? readOnlyBlobs(options.storage.blobs)
        : options.storage.blobs,
      limits,
      createdIds,
      extraResponses: [],
      isReadOnly: access?.isReadOnly === true,
      using: [],
      user,
      quotaOctets: options.quota?.maxOctets ?? null,
      principals: async () =>
        [user.accountId, ...Object.keys(user.sharedAccounts ?? {})].flatMap(
          (id) => {
            const account = describeAccount(user, id);
            if (!account) return [];
            const isOwn = id === user.accountId;
            return [
              {
                id,
                // A shared account stands for whoever shares it: a team, usually.
                type: isOwn ? ('individual' as const) : ('group' as const),
                name: account['name'] as string,
                description: null,
                email:
                  isOwn && user.username.includes('@') ? user.username : null,
                timeZone: null,
                capabilities: {},
                accounts: { [id]: account },
              },
            ];
          },
        ),
      forAccount: (other) =>
        accessTo(user, other)
          ? makeContext(user, other, createdIds)
          : undefined,
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      maxDelayedSend,
      subscribeByDefault: options.subscribeNewMailboxes === true,
      threadsRequireSameSubject: options.threadsRequireSameSubject === true,
      ...(options.onAutoReply ? { onAutoReply: options.onAutoReply } : {}),
      identities: async (): Promise<ResolvedIdentity[]> => {
        const configured = (await options.identities?.(auth)) ?? [];
        // What the user changed (name, signatures, reply-to) is kept per identity.
        const settings = new Map(
          configured.length === 0
            ? []
            : (
                await metadata.get(
                  auth.accountId,
                  IDENTITY_SETTINGS,
                  configured.map((identity) => identity.id),
                )
              ).map((record) => [record.id, record.value]),
        );
        return configured.map((identity) => ({
          allowedFrom: identity.allowedFrom ?? [],
          id: identity.id,
          name: identity.name ?? '',
          email: identity.email,
          replyTo: null,
          bcc: null,
          textSignature: '',
          htmlSignature: '',
          ...(settings.get(identity.id) as
            Partial<ResolvedIdentity> | undefined),
          mayDelete: false,
        }));
      },
    };
  };

  return {
    limits,

    getSession(auth) {
      return {
        capabilities,
        accounts: Object.fromEntries(
          [auth.accountId, ...Object.keys(auth.sharedAccounts ?? {})].flatMap(
            (accountId) => {
              const account = describeAccount(auth, accountId);
              return account ? [[accountId, account]] : [];
            },
          ),
        ) as unknown as Session['accounts'],
        // The user's own account, for everything the server offers.
        primaryAccounts: Object.fromEntries(
          Object.keys(capabilities).map((capability) => [
            capability,
            auth.accountId,
          ]),
        ),
        username: auth.username,
        apiUrl: options.urls.api,
        downloadUrl: options.urls.download,
        uploadUrl: options.urls.upload,
        eventSourceUrl: options.urls.eventSource,
        state: sessionStateFor(auth),
      };
    },

    async handleRequest(request, auth) {
      const parsed = RequestSchema.safeParse(request);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RequestError(
          REQUEST_ERROR.notRequest,
          `${issue?.path.join('/') ?? ''}: ${issue?.message ?? 'invalid request'}`,
        );
      }
      const { using, methodCalls, createdIds } = parsed.data;

      for (const capability of using) {
        if (!Object.prototype.hasOwnProperty.call(capabilities, capability)) {
          throw new RequestError(
            REQUEST_ERROR.unknownCapability,
            `The capability "${capability}" is not supported`,
          );
        }
      }
      if (methodCalls.length > limits.maxCallsInRequest) {
        throw new RequestError(
          REQUEST_ERROR.limit,
          `A request may contain at most ${limits.maxCallsInRequest} method calls`,
          { limit: 'maxCallsInRequest' },
        );
      }

      const ctx = makeContext(auth);
      ctx.using = using;
      for (const [creationId, id] of Object.entries(createdIds ?? {})) {
        ctx.createdIds.set(creationId, id);
      }

      const methodResponses: Invocation[] = [];
      for (const [name, rawArgs, callId] of methodCalls) {
        try {
          const definition = methods.get(name);
          if (!definition || !using.includes(definition.capability)) {
            throw new MethodError('unknownMethod');
          }
          const args = resolveResultReferences(rawArgs, methodResponses);
          // A call that names an account shared with the user runs in that
          // account. Any other id is left for the method to refuse.
          const named = args['accountId'];
          const callCtx =
            (typeof named === 'string' && named !== auth.accountId
              ? ctx.forAccount(named)
              : undefined) ?? ctx;
          // Refused up front, so that a call which happens to change nothing
          // is not mistaken for one that was allowed.
          if (
            /\/(set|import|copy|upload|send)$/.test(name) &&
            accessTo(auth, callCtx.auth.accountId)?.isReadOnly
          ) {
            throw new MethodError('accountReadOnly');
          }
          callCtx.using = using;
          callCtx.extraResponses = [];
          methodResponses.push([
            name,
            await definition.handler(args, callCtx),
            callId,
          ]);
          for (const [extraName, extraArgs] of callCtx.extraResponses) {
            methodResponses.push([extraName, extraArgs, callId]);
          }
        } catch (error) {
          if (error instanceof MethodError) {
            options.onMethodError?.(
              name,
              error.type,
              error.message === error.type ? undefined : error.message,
            );
            methodResponses.push(['error', error.toJSON(), callId]);
          } else {
            options.onError?.(error, name);
            methodResponses.push(['error', { type: 'serverFail' }, callId]);
          }
        }
      }

      options.onRequest?.({
        calls: methodCalls.map(([name]) => name),
        results: methodResponses.map(([name, result]) => {
          if (name === 'error') return `error:${String(result['type'])}`;
          const rejected = ['notCreated', 'notUpdated', 'notDestroyed'].flatMap(
            (property) =>
              Object.values(
                (result[property] as Record<
                  string,
                  { type?: string }
                > | null) ?? {},
              ).map((error) => String(error.type)),
          );
          return rejected.length === 0
            ? name
            : `${name}!${[...new Set(rejected)].join(',')}`;
        }),
      });

      return {
        methodResponses,
        ...(createdIds
          ? { createdIds: Object.fromEntries(ctx.createdIds) }
          : {}),
        sessionState: sessionStateFor(auth),
      };
    },

    async upload(auth, accountId, data, type) {
      const access = accessTo(auth, accountId);
      if (!access) {
        throw new RequestError('about:blank', 'Account not found', {
          status: 404,
        });
      }
      if (access.isReadOnly) {
        throw new RequestError('about:blank', 'The account is read-only', {
          status: 403,
        });
      }
      if (data.length > limits.maxSizeUpload) {
        throw new RequestError(
          REQUEST_ERROR.limit,
          `Uploads may be at most ${limits.maxSizeUpload} bytes`,
          { status: 413, limit: 'maxSizeUpload' },
        );
      }
      const blobId = generateId('bu');
      await options.storage.blobs.put(accountId, blobId, data);
      return { accountId, blobId, type, size: data.length };
    },

    async download(auth, accountId, blobId) {
      if (!accessTo(auth, accountId)) return null;
      if (!IdSchema.safeParse(blobId).success) return null;
      return readBlob(makeContext(auth, accountId), blobId);
    },

    importMessage(auth, raw, importOptions) {
      return importMessage(makeContext(auth), raw, importOptions);
    },

    async provisionAccount(auth) {
      const ctx = makeContext(auth);
      await provisionMailboxes(ctx);
      await provisionAddressBooks(ctx);
    },

    recordDelivery(auth, submissionId, updates) {
      return recordDelivery(makeContext(auth), submissionId, updates);
    },

    sendScheduled(auth, submissionId) {
      return sendScheduled(makeContext(auth), submissionId);
    },

    async pushStateChange(accountId, types) {
      if (!push) return { sent: 0, failed: 0, removed: 0 };
      return pushStateChange(metadata, push, accountId, types);
    },

    registerMethod(name, definition) {
      methods.set(name, definition);
    },
  };
}
