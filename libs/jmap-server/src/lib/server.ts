import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_SUBMISSION,
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
  recordDelivery,
  submissionMethods,
  type DeliveryUpdate,
} from './mail/submission.js';
import { threadMethods } from './mail/thread.js';
import type { StorageAdapter } from './storage.js';
import type { MailTransport } from './transport.js';

export const DEFAULT_LIMITS: CoreCapability = {
  maxSizeUpload: 50_000_000,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  collationAlgorithms: [],
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
   * The addresses an account may send from. An email of `*@example.com`
   * allows any address at that domain.
   */
  identities?: (
    auth: AuthContext,
  ) => IdentityInput[] | Promise<IdentityInput[]>;
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
  registerMethod(name: string, definition: MethodDefinition): void;
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
  const submissionCapability = { maxDelayedSend: 0, submissionExtensions: {} };
  const canSend = options.transport !== undefined;
  const capabilities: Record<string, unknown> = {
    [CAPABILITY_CORE]: limits,
    [CAPABILITY_MAIL]: {},
    ...(canSend ? { [CAPABILITY_SUBMISSION]: submissionCapability } : {}),
  };
  const mailAccountCapability: MailAccountCapability = {
    maxMailboxesPerEmail: null,
    maxMailboxDepth: MAX_MAILBOX_DEPTH,
    maxSizeMailboxName: 255,
    maxSizeAttachmentsPerEmail: limits.maxSizeUpload,
    emailQuerySortOptions: EMAIL_SORT_OPTIONS,
    mayCreateTopLevelMailbox: true,
  };
  const sessionState = hash(
    JSON.stringify([capabilities, mailAccountCapability, options.urls]),
  );

  const methods = new Map<string, MethodDefinition>();
  methods.set('Core/echo', {
    capability: CAPABILITY_CORE,
    handler: async (args) => args,
  });
  // Push is not offered, so there are never any subscriptions. Clients ask anyway when
  // setting up an account, and "none" is the answer they can work with.
  const PushSubscriptionGet = z.strictObject({
    ids: z.array(z.string()).nullish(),
    properties: z.array(z.string()).nullish(),
  });
  methods.set('PushSubscription/get', {
    capability: CAPABILITY_CORE,
    handler: async (args) => {
      const { ids } = parseArguments(PushSubscriptionGet, args);
      return { list: [], notFound: ids ?? [] };
    },
  });
  const PushSubscriptionSet = z.strictObject({
    create: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
    update: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
    destroy: z.array(z.string()).nullish(),
  });
  methods.set('PushSubscription/set', {
    capability: CAPABILITY_CORE,
    handler: async (args) => {
      const { create, update, destroy } = parseArguments(
        PushSubscriptionSet,
        args,
      );
      const refuse = (keys: string[], type: string, description?: string) =>
        keys.length === 0
          ? null
          : Object.fromEntries(
              keys.map((key) => [
                key,
                { type, ...(description ? { description } : {}) },
              ]),
            );
      return {
        created: null,
        updated: null,
        destroyed: null,
        notCreated: refuse(
          Object.keys(create ?? {}),
          'forbidden',
          'Push notifications are not available on this server',
        ),
        notUpdated: refuse(Object.keys(update ?? {}), 'notFound'),
        notDestroyed: refuse(destroy ?? [], 'notFound'),
      };
    },
  });

  for (const group of [mailboxMethods, emailMethods, threadMethods]) {
    for (const [name, handler] of Object.entries(group)) {
      methods.set(name, { capability: CAPABILITY_MAIL, handler });
    }
  }
  if (canSend) {
    for (const [name, handler] of Object.entries(submissionMethods)) {
      methods.set(name, { capability: CAPABILITY_SUBMISSION, handler });
    }
  }

  const makeContext = (auth: AuthContext): MethodContext => ({
    auth,
    store: options.storage.metadata,
    blobs: options.storage.blobs,
    limits,
    createdIds: new Map(),
    extraResponses: [],
    ...(options.transport ? { transport: options.transport } : {}),
    identities: async (): Promise<ResolvedIdentity[]> =>
      ((await options.identities?.(auth)) ?? []).map((identity) => ({
        allowedFrom: identity.allowedFrom ?? [],
        id: identity.id,
        name: identity.name ?? '',
        email: identity.email,
        replyTo: null,
        bcc: null,
        textSignature: '',
        htmlSignature: '',
        mayDelete: false,
      })),
  });

  return {
    limits,

    getSession(auth) {
      return {
        capabilities,
        accounts: {
          [auth.accountId]: {
            name: auth.username,
            isPersonal: true,
            isReadOnly: false,
            accountCapabilities: {
              [CAPABILITY_CORE]: {},
              [CAPABILITY_MAIL]: mailAccountCapability,
              ...(canSend
                ? { [CAPABILITY_SUBMISSION]: submissionCapability }
                : {}),
            },
          },
        },
        primaryAccounts: {
          [CAPABILITY_CORE]: auth.accountId,
          [CAPABILITY_MAIL]: auth.accountId,
          ...(canSend ? { [CAPABILITY_SUBMISSION]: auth.accountId } : {}),
        },
        username: auth.username,
        apiUrl: options.urls.api,
        downloadUrl: options.urls.download,
        uploadUrl: options.urls.upload,
        eventSourceUrl: options.urls.eventSource,
        state: sessionState,
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
          ctx.extraResponses = [];
          methodResponses.push([
            name,
            await definition.handler(args, ctx),
            callId,
          ]);
          for (const [extraName, extraArgs] of ctx.extraResponses) {
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
        sessionState,
      };
    },

    async upload(auth, accountId, data, type) {
      if (accountId !== auth.accountId) {
        throw new RequestError('about:blank', 'Account not found', {
          status: 404,
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
      if (accountId !== auth.accountId) return null;
      if (!IdSchema.safeParse(blobId).success) return null;
      return readBlob(makeContext(auth), blobId);
    },

    importMessage(auth, raw, importOptions) {
      return importMessage(makeContext(auth), raw, importOptions);
    },

    provisionAccount(auth) {
      return provisionMailboxes(makeContext(auth));
    },

    recordDelivery(auth, submissionId, updates) {
      return recordDelivery(makeContext(auth), submissionId, updates);
    },

    registerMethod(name, definition) {
      methods.set(name, definition);
    },
  };
}
