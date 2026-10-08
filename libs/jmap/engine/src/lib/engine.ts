import {
  CAPABILITY_CORE,
  CAPABILITY_WEBPUSH_VAPID,
  IdSchema,
  MethodError,
  REQUEST_ERROR,
  RequestError,
  RequestSchema,
  resolveResultReferences,
  type CoreCapability,
  type Invocation,
  type JmapResponse,
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
} from './context.js';
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

/*
 * The JMAP engine (RFC 8620): requests, sessions, accounts, blobs and push.
 * It knows nothing of mail, contacts or any other kind of data. Those come
 * as modules, each bringing its methods and what the session says about it.
 */

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

/** An account as one user may use it. */
export interface AccountAccess {
  /** The user asking. */
  user: AuthContext;
  accountId: string;
  /** How the account is shown to the user. */
  name: string;
  /** Whether it is the user's own. */
  isPersonal: boolean;
  isReadOnly: boolean;
  /** The limits of the server, which what an account allows may depend on. */
  limits: CoreCapability;
}

/**
 * One kind of data a server offers: mail, contacts, and so on. A module
 * brings its methods and says what the session tells clients about it; the
 * engine does the rest.
 */
export interface JmapModule {
  /** For error reports: which module something came from. */
  name: string;
  /** What the session says the server can do, by capability. */
  capabilities?: Record<string, unknown>;
  /** What the session says about one account, by capability. */
  accountCapabilities?(access: AccountAccess): Record<string, unknown>;
  /** The methods, by name, each with the capability a request must name to call it. */
  methods?: Record<string, MethodDefinition>;
  /**
   * Adds what this module's methods need to a context, under a name of its
   * own. Called for every context, including those for shared accounts.
   */
  extendContext?(ctx: MethodContext): void;
  /** Gives a new account what it starts with. Must do nothing the second time. */
  provisionAccount?(ctx: MethodContext): Promise<void>;
  /**
   * Called before the first request for an account that this server handles,
   * and when an account is provisioned: for what has to be true of an account
   * before it is used. A failure is reported and never fails the request.
   */
  prepareAccount?(ctx: MethodContext): Promise<void>;
  /** The data types whose changes are pushed to clients. */
  pushedTypes?: readonly string[];
  /**
   * The content of a blob that is not an object in the blob store, such as a
   * part of a message. Undefined when the id is not one of this module's, so
   * that the next module, and then the blob store, is asked.
   */
  readBlob?(
    ctx: MethodContext,
    blobId: string,
  ): Promise<Uint8Array | null | undefined>;
}

export interface JmapEngineOptions {
  storage: StorageAdapter;
  urls: JmapServerUrls;
  limits?: Partial<CoreCapability>;
  /** The kinds of data this server offers. */
  modules?: readonly JmapModule[];
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
   * Lets clients register where to be told of changes (RFC 8620 §7.2).
   * Without it, `PushSubscription/set` declines every subscription. The host
   * does the telling: it calls `pushStateChange` when something changed.
   */
  push?: PushOptions;
  /**
   * Called after every write with the account and the data types written.
   * For hosts that can push from the same process; others watch their store.
   */
  onStateChange?: (accountId: string, types: string[]) => void;
}

export interface RequestSummary {
  calls: string[];
  /**
   * One entry per response: the method name, `error:<type>` for a method
   * error, or `<Method>!<type>,<type>` when a /set call rejected objects.
   */
  results: string[];
}

export interface JmapEngine {
  readonly limits: CoreCapability;
  /** The data types whose changes are pushed to clients: those the modules name. */
  readonly pushedTypes: readonly string[];
  getSession(auth: AuthContext): Session;
  /** Handles one JMAP request. Throws RequestError for request-level failures. */
  handleRequest(request: unknown, auth: AuthContext): Promise<JmapResponse>;
  upload(
    auth: AuthContext,
    accountId: string,
    data: Uint8Array,
    type: string,
  ): Promise<UploadResponse>;
  /** Returns the blob's bytes, or null when it does not exist in that account. */
  download(
    auth: AuthContext,
    accountId: string,
    blobId: string,
  ): Promise<Uint8Array | null>;
  /** Gives an account what each module starts it with, if it has none of it yet. */
  provisionAccount(auth: AuthContext): Promise<void>;
  /**
   * Tells an account's push subscriptions that data changed. `types` limits
   * the push to the types that changed. Does nothing when push is not enabled.
   */
  pushStateChange(
    accountId: string,
    types?: readonly string[],
  ): Promise<PushReport>;
  /** Adds or replaces a method, for capabilities implemented outside any module. */
  registerMethod(name: string, definition: MethodDefinition): void;
  /**
   * The context a method would be given, for what a host does outside any
   * request: delivering a message, sending one that was held. For the user's
   * own account unless another they may use is named.
   */
  contextFor(auth: AuthContext, accountId?: string): MethodContext;
}

/**
 * What a state string starts with. A store may number its states from zero,
 * and to a client that treats "0" as no state at all, a fresh account would
 * look as if it had none. With a letter in front, no state can be mistaken
 * for a number, and none is ever empty.
 */
const STATE_PREFIX = 's';

/**
 * Removing a whole account is for whoever closes it, with the storage in
 * hand. No method has a reason to, so the stores methods are given refuse.
 */
const notForMethods = async (): Promise<never> => {
  throw new Error('An account is purged through its storage, not by a method');
};

/** A store whose states carry the prefix, in and out. */
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
      // A state that was never given out cannot be counted from.
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
    purge: notForMethods,
  };
}

/** A store that reports each commit's account and data types once the write has succeeded. */
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
    purge: notForMethods,
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

export function createJmapEngine(options: JmapEngineOptions): JmapEngine {
  const limits: CoreCapability = { ...DEFAULT_LIMITS, ...options.limits };
  const modules = options.modules ?? [];

  const capabilities: Record<string, unknown> = Object.assign(
    { [CAPABILITY_CORE]: limits },
    ...modules.map((module) => module.capabilities ?? {}),
  );
  const pushedTypes = [
    ...new Set(modules.flatMap((module) => module.pushedTypes ?? [])),
  ];
  // Made here, before the session is described: the key it offers is part of
  // the session, so that replacing it changes the session state (RFC 9749 §4).
  const push = options.push
    ? resolvePushOptions(options.push, pushedTypes)
    : undefined;
  if (push?.vapid) {
    capabilities[CAPABILITY_WEBPUSH_VAPID] = {
      applicationServerKey: push.vapid.publicKey,
    };
  }

  /**
   * What a user may do with an account: everything with their own, and what
   * the host says with one shared with them. Undefined for any other account,
   * whether or not it exists.
   */
  const accessTo = (
    user: AuthContext,
    accountId: string,
  ): AccountAccess | undefined => {
    if (accountId === user.accountId) {
      return {
        user,
        accountId,
        limits,
        isReadOnly: false,
        name: user.username,
        isPersonal: true,
      };
    }
    const shared = Object.prototype.hasOwnProperty.call(
      user.sharedAccounts ?? {},
      accountId,
    )
      ? user.sharedAccounts?.[accountId]
      : undefined;
    return shared
      ? {
          user,
          accountId,
          limits,
          isReadOnly: shared.isReadOnly === true,
          name: shared.name ?? accountId,
          isPersonal: false,
        }
      : undefined;
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
      accountCapabilities: Object.assign(
        { [CAPABILITY_CORE]: {} },
        ...modules.map((module) => module.accountCapabilities?.(access) ?? {}),
      ),
    };
  };
  const describeAccounts = (
    user: AuthContext,
  ): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      [user.accountId, ...Object.keys(user.sharedAccounts ?? {})].flatMap(
        (accountId) => {
          const account = describeAccount(user, accountId);
          return account ? [[accountId, account]] : [];
        },
      ),
    );

  // What the session says that does not depend on who asks.
  const sessionState = hash(
    JSON.stringify([
      capabilities,
      describeAccount({ accountId: '', username: '' }, ''),
      options.urls,
    ]),
  );
  // A user's session also says which accounts are shared with them, and that can change.
  const sessionStateFor = (auth: AuthContext): string =>
    auth.sharedAccounts && Object.keys(auth.sharedAccounts).length > 0
      ? hash(sessionState + JSON.stringify(auth.sharedAccounts))
      : sessionState;

  const states = publicStates(options.storage.metadata);
  const metadata = options.onStateChange
    ? reportingCommits(states, options.onStateChange)
    : states;

  /** A store that reads as usual and refuses every write. */
  const readOnly = (store: MetadataStore): MetadataStore => ({
    getState: (accountId, type) => store.getState(accountId, type),
    get: (accountId, type, ids) => store.get(accountId, type, ids),
    list: (accountId, type, index) => store.list(accountId, type, index),
    getChanges: (accountId, type, sinceState) =>
      store.getChanges(accountId, type, sinceState),
    commit: async () => {
      throw new MethodError('accountReadOnly');
    },
    purge: notForMethods,
  });
  const readOnlyBlobs = (blobs: BlobStore): BlobStore => ({
    get: (accountId, blobId) => blobs.get(accountId, blobId),
    put: async () => {
      throw new MethodError('accountReadOnly');
    },
    delete: async () => {
      throw new MethodError('accountReadOnly');
    },
    purge: notForMethods,
  });

  /**
   * The context for one account, as one user may use it. A read-only account
   * gets storage that refuses writes, so that no method can change it even by
   * a route nobody thought to guard.
   */
  const makeContext = (
    user: AuthContext,
    accountId: string = user.accountId,
    createdIds: Map<string, string> = new Map(),
  ): MethodContext => {
    const access = accessTo(user, accountId);
    // The part every method has. Each module then adds its own to it, which is
    // why this is not yet all that the type promises.
    const ctx = {
      auth: { accountId, username: user.username },
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
      accounts: () => describeAccounts(user),
      forAccount: (other: string) =>
        accessTo(user, other)
          ? makeContext(user, other, createdIds)
          : undefined,
      async readBlob(blobId: string) {
        for (const module of modules) {
          const found = await module.readBlob?.(ctx, blobId);
          if (found !== undefined) return found;
        }
        return ctx.blobs.get(accountId, blobId);
      },
    } as unknown as MethodContext;
    for (const module of modules) module.extendContext?.(ctx);
    return ctx;
  };

  const methods = new Map<string, MethodDefinition>();
  methods.set('Core/echo', {
    capability: CAPABILITY_CORE,
    handler: async (args) => args,
  });
  // Copies blobs between two accounts the user may use (RFC 8620 §6.3).
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
          ? await from.readBlob(blobId)
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
  for (const [name, handler] of Object.entries(
    push ? pushMethods(push) : pushMethodsWhenDisabled,
  )) {
    methods.set(name, { capability: CAPABILITY_CORE, handler });
  }
  for (const module of modules) {
    for (const [name, definition] of Object.entries(module.methods ?? {})) {
      methods.set(name, definition);
    }
  }

  /**
   * The accounts this engine has seen prepared. What a module needs to be
   * true of an account is seen to once; this keeps the check for it to one
   * call per account for as long as the engine runs.
   */
  const prepared = new Set<string>();
  const prepare = async (ctx: MethodContext): Promise<void> => {
    const accountId = ctx.auth.accountId;
    if (prepared.has(accountId)) return;
    try {
      for (const module of modules) await module.prepareAccount?.(ctx);
      prepared.add(accountId);
    } catch (error) {
      // Getting an account ready must never be why a request fails.
      options.onError?.(error, 'prepareAccount');
    }
  };

  return {
    limits,
    pushedTypes,

    getSession(auth) {
      return {
        capabilities,
        accounts: describeAccounts(auth) as unknown as Session['accounts'],
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
      await prepare(ctx);
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
          // A call may name any account the user has access to; it then runs in that account.
          const named = args['accountId'];
          const callCtx =
            (typeof named === 'string' && named !== auth.accountId
              ? ctx.forAccount(named)
              : undefined) ?? ctx;
          // Refused before it runs: a call that changes nothing would otherwise look allowed.
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
      return makeContext(auth, accountId).readBlob(blobId);
    },

    async provisionAccount(auth) {
      const ctx = makeContext(auth);
      for (const module of modules) await module.provisionAccount?.(ctx);
      await prepare(ctx);
    },

    async pushStateChange(accountId, types) {
      if (!push) return { sent: 0, failed: 0, removed: 0 };
      return pushStateChange(metadata, push, accountId, types);
    },

    registerMethod(name, definition) {
      methods.set(name, definition);
    },

    contextFor: (auth, accountId) => makeContext(auth, accountId),
  };
}
