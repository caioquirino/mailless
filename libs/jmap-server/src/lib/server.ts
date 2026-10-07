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
  type Identity,
  type Invocation,
  type JmapResponse,
  type MailAccountCapability,
  type Session,
  type UploadResponse,
} from '@mailless/jmap-core';
import {
  generateId,
  type AuthContext,
  type MethodContext,
  type MethodDefinition,
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
import { submissionMethods } from './mail/submission.js';
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

export interface IdentityInput {
  id: string;
  email: string;
  name?: string;
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
    identities: async (): Promise<Identity[]> =>
      ((await options.identities?.(auth)) ?? []).map((identity) => ({
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
            methodResponses.push(['error', error.toJSON(), callId]);
          } else {
            options.onError?.(error, name);
            methodResponses.push(['error', { type: 'serverFail' }, callId]);
          }
        }
      }

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

    registerMethod(name, definition) {
      methods.set(name, definition);
    },
  };
}
