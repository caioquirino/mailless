import {
  CAPABILITY_BLOB,
  CAPABILITY_MAIL,
  CAPABILITY_MDN,
  CAPABILITY_QUOTA,
  CAPABILITY_SUBMISSION,
  CAPABILITY_VACATION,
  type MailAccountCapability,
} from '@mailless/jmap-core';
import type {
  AuthContext,
  JmapModule,
  MethodDefinition,
  MethodHandler,
} from '@mailless/jmap-engine';
import {
  blobMethods,
  DIGEST_ALGORITHMS,
  LOOKUP_TYPES,
  MAX_DATA_SOURCES,
} from './blob.js';
import type { ResolvedIdentity } from './context.js';
import { EMAIL_SORT_OPTIONS, emailMethods, readBlob } from './email.js';
import {
  mailboxMethods,
  MAX_MAILBOX_DEPTH,
  provisionMailboxes,
} from './mailbox.js';
import { mdnMethods } from './mdn.js';
import { splitPartBlobId } from './mime.js';
import { EMAIL, EMAIL_DELIVERY, MAILBOX, THREAD } from './model.js';
import { countedUsage, QUOTA, quotaMethods } from './quota.js';
import {
  IDENTITY_SETTINGS,
  SUBMISSION,
  submissionMethods,
} from './submission.js';
import { threadMethods } from './thread.js';
import type { MailTransport, SendScheduler } from './transport.js';
import { vacationMethods } from './vacation.js';

/** An address the caller may send from, as the host declares it. */
export interface IdentityInput {
  id: string;
  /** The address in From. `*@example.com` allows any address at that domain. */
  email: string;
  /** The display name in From; clients fall back to it. */
  name?: string;
  /**
   * Further addresses, or `*@domain` patterns, this identity may send as.
   * For an account that owns a whole domain: its identities have a real
   * address for clients to offer, and may also send as any other.
   */
  allowedFrom?: string[];
}

export interface MailModuleOptions {
  /**
   * How outgoing mail leaves. When set, the server offers the submission
   * capability (Identity and EmailSubmission methods), the vacation response
   * and read receipts.
   */
  transport?: MailTransport;
  /**
   * A limit on how much mail an account may hold, in octets. With one, the
   * account has a quota that clients can show. Mail arriving from outside is
   * never refused for it; what the user adds themself is.
   *
   * One number is the limit of every account. A function is asked per
   * account, and answers null for an account without a limit.
   */
  quota?: {
    maxOctets:
      number | ((accountId: string) => number | null | Promise<number | null>);
  };
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
   * Arranges for a held message to be sent later. With it, the server offers
   * delayed sending (FUTURERELEASE), which is also how "undo send" works; the
   * host calls `sendScheduled` when the time has come. Without it, a message
   * is sent at once.
   */
  scheduler?: SendScheduler;
  /** The longest a message may be held, in seconds. Default 30 days. */
  maxDelayedSend?: number;
  /**
   * The addresses a caller may send from. Identities are configuration, not
   * user data: clients can read them but not change them. Without this the
   * caller has no identities and cannot submit mail.
   */
  identities?: (
    auth: AuthContext,
  ) => IdentityInput[] | Promise<IdentityInput[]>;
  /**
   * Told what became of the vacation response for each delivered message
   * while one is enabled: the outcome's name only, plus the error when the
   * reply could not be sent.
   */
  onAutoReply?: (outcome: string, error?: unknown) => void;
}

const under = (
  capability: string,
  ...groups: Array<Record<string, MethodHandler>>
): Record<string, MethodDefinition> =>
  Object.fromEntries(
    groups.flatMap((group) =>
      Object.entries(group).map(([name, handler]) => [
        name,
        { capability, handler },
      ]),
    ),
  );

/**
 * Mail for a JMAP server (RFC 8621): mailboxes, emails and threads, and with
 * a transport also sending, the vacation response and read receipts. With it
 * come blob management (RFC 9404) and the quota of what mail takes up
 * (RFC 9425).
 */
export function mailModule(options: MailModuleOptions = {}): JmapModule {
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
  // Offered with sending: a vacation response and a read receipt are messages sent.
  const sending = canSend
    ? {
        [CAPABILITY_SUBMISSION]: submissionCapability,
        [CAPABILITY_VACATION]: {},
        [CAPABILITY_MDN]: {},
      }
    : {};

  return {
    name: 'mail',
    capabilities: {
      [CAPABILITY_MAIL]: {},
      [CAPABILITY_BLOB]: {},
      [CAPABILITY_QUOTA]: {},
      ...sending,
    },
    accountCapabilities: ({ limits }) => ({
      [CAPABILITY_MAIL]: {
        maxMailboxesPerEmail: null,
        maxMailboxDepth: MAX_MAILBOX_DEPTH,
        maxSizeMailboxName: 255,
        maxSizeAttachmentsPerEmail: limits.maxSizeUpload,
        emailQuerySortOptions: EMAIL_SORT_OPTIONS,
        mayCreateTopLevelMailbox: true,
      } satisfies MailAccountCapability,
      [CAPABILITY_BLOB]: {
        maxSizeBlobSet: limits.maxSizeUpload,
        maxDataSources: MAX_DATA_SOURCES,
        supportedTypeNames: LOOKUP_TYPES,
        supportedDigestAlgorithms: DIGEST_ALGORITHMS,
      },
      [CAPABILITY_QUOTA]: {},
      ...sending,
    }),
    methods: {
      ...under(CAPABILITY_MAIL, mailboxMethods, emailMethods, threadMethods),
      ...under(CAPABILITY_BLOB, blobMethods),
      ...under(CAPABILITY_QUOTA, quotaMethods),
      ...(canSend
        ? {
            ...under(CAPABILITY_MDN, mdnMethods),
            ...under(CAPABILITY_SUBMISSION, submissionMethods),
            ...under(CAPABILITY_VACATION, vacationMethods),
          }
        : {}),
    },
    extendContext(ctx) {
      let quotaOctets: Promise<number | null> | undefined;
      ctx.mail = {
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.scheduler ? { scheduler: options.scheduler } : {}),
        maxDelayedSend,
        subscribeByDefault: options.subscribeNewMailboxes === true,
        threadsRequireSameSubject: options.threadsRequireSameSubject === true,
        quotaOctets: () =>
          (quotaOctets ??= (async () => {
            const max = options.quota?.maxOctets;
            if (max === undefined) return null;
            return typeof max === 'number' ? max : max(ctx.auth.accountId);
          })()),
        ...(options.onAutoReply ? { onAutoReply: options.onAutoReply } : {}),
        identities: async (): Promise<ResolvedIdentity[]> => {
          const configured = (await options.identities?.(ctx.auth)) ?? [];
          // What the user changed about an identity is kept; the rest is as configured.
          const settings = new Map(
            configured.length === 0
              ? []
              : (
                  await ctx.store.get(
                    ctx.auth.accountId,
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
    },
    provisionAccount: provisionMailboxes,
    // An account's mail is counted once, the first time it is used after the count was introduced.
    prepareAccount: async (ctx) => {
      await countedUsage(ctx);
    },
    pushedTypes: [
      MAILBOX,
      EMAIL,
      THREAD,
      EMAIL_DELIVERY,
      SUBMISSION,
      // RFC 9425 §6: clients are told when a quota's usage changes.
      QUOTA,
    ],
    // A part of a message is a blob too, though it is no object in the blob store.
    readBlob: async (ctx, blobId) =>
      splitPartBlobId(blobId) ? readBlob(ctx, blobId) : undefined,
  };
}
