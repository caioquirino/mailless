import {
  applyPatch,
  CAPABILITY_VACATION,
  GetArgumentsSchema,
  MethodError,
  PatchError,
  SetArgumentsSchema,
  SetFailure,
  UTCDateSchema,
  type SetError,
} from '@mailless/jmap-core';
import { addressParser } from 'postal-mime';
import {
  composeMessage,
  encodeText,
  formatAddresses,
  formatDate,
  formatMessageIds,
  isValidAddress,
  type ComposePart,
} from './compose.js';
import { headerValues } from './headers.js';
import { htmlToText, type ParsedMessage } from './mime.js';
import { identityAllows } from './submission.js';

import {
  ConflictError,
  parseArguments,
  pick,
  requireAccount,
  retryOnConflict,
  selectProperties,
  toUtcDate,
  type MethodContext,
  type MethodHandler,
} from '@mailless/jmap-engine';
export { CAPABILITY_VACATION };

/*
 * The vacation response (RFC 8621 §8): one settings object per account, and
 * the automatic reply it asks for when mail arrives. Replies follow RFC 3834,
 * which exists to keep automatic senders from answering each other, mailing
 * lists and bounces.
 */

const VACATION = 'VacationResponse';
const SINGLETON = 'singleton';
/** Who has been answered, so that nobody is answered again for a while. */
const VACATION_REPLIED = 'VacationReplied';
const REPLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_LENGTH = 50_000;
const DEFAULT_BODY =
  'This is an automatic reply. I am away and may not read your message for some time.';

type VacationValue = {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
};
const DEFAULTS: VacationValue = {
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: null,
  textBody: null,
  htmlBody: null,
};
const PROPERTIES = ['id', ...Object.keys(DEFAULTS)];

async function load(
  ctx: MethodContext,
): Promise<{ value: VacationValue; version: number }> {
  const [record] = await ctx.store.get(ctx.auth.accountId, VACATION, [
    SINGLETON,
  ]);
  return record
    ? { value: record.value as VacationValue, version: record.version }
    : { value: DEFAULTS, version: 0 };
}

function invalidProperties(value: VacationValue): string[] {
  const isDate = (date: unknown) =>
    date === null || UTCDateSchema.safeParse(date).success;
  const isText = (text: unknown, max: number) =>
    text === null || (typeof text === 'string' && text.length <= max);
  const checks: Record<string, boolean> = {
    isEnabled: typeof value.isEnabled === 'boolean',
    fromDate: isDate(value.fromDate),
    toDate: isDate(value.toDate),
    subject: isText(value.subject, 255) && !/[\r\n]/.test(value.subject ?? ''),
    textBody: isText(value.textBody, MAX_BODY_LENGTH),
    htmlBody: isText(value.htmlBody, MAX_BODY_LENGTH),
  };
  return [
    ...Object.keys(value).filter((property) => !(property in checks)),
    ...Object.keys(checks).filter((property) => !checks[property]),
  ];
}

async function update(
  ctx: MethodContext,
  patch: Record<string, unknown>,
): Promise<void> {
  await retryOnConflict(async () => {
    const current = await load(ctx);
    let next: VacationValue & { id?: unknown };
    try {
      next = applyPatch({ id: SINGLETON, ...current.value }, patch);
    } catch (error) {
      if (error instanceof PatchError) {
        throw new SetFailure('invalidPatch', error.message);
      }
      throw error;
    }
    // The id may be sent back as it is, and not changed.
    const { id, ...value } = next;
    const refused = [
      ...(id === SINGLETON ? [] : ['id']),
      ...invalidProperties(value),
    ];
    if (refused.length > 0) {
      throw new SetFailure('invalidProperties', undefined, {
        properties: refused,
      });
    }
    await ctx.store.commit(ctx.auth.accountId, [
      current.version === 0
        ? { kind: 'create', type: VACATION, id: SINGLETON, value }
        : {
            kind: 'update',
            type: VACATION,
            id: SINGLETON,
            value,
            expectedVersion: current.version,
          },
    ]);
  });
}

export const vacationMethods: Record<string, MethodHandler> = {
  'VacationResponse/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, PROPERTIES);
    const state = await ctx.store.getState(accountId, VACATION);
    const ids = [...new Set(args.ids ?? [SINGLETON])];
    const { value } = await load(ctx);
    return {
      accountId,
      state,
      // There is always exactly one, whether or not anything was ever set.
      list: ids.includes(SINGLETON)
        ? [pick({ id: SINGLETON, ...value }, properties)]
        : [],
      notFound: ids.filter((id) => id !== SINGLETON),
    };
  },

  'VacationResponse/set': async (rawArgs, ctx) => {
    const args = parseArguments(SetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const oldState = await ctx.store.getState(accountId, VACATION);
    if (
      args.ifInState !== null &&
      args.ifInState !== undefined &&
      args.ifInState !== oldState
    ) {
      throw new MethodError('stateMismatch');
    }
    const singleton = (ids: string[], description: string) =>
      ids.length === 0
        ? null
        : Object.fromEntries(
            ids.map((id): [string, SetError] => [
              id,
              { type: 'singleton', description },
            ]),
          );

    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    for (const [id, patch] of Object.entries(args.update ?? {})) {
      try {
        if (id !== SINGLETON) throw new SetFailure('notFound');
        await update(ctx, patch);
        updated[id] = null;
      } catch (error) {
        if (!(error instanceof SetFailure)) throw error;
        notUpdated[id] = error.error;
      }
    }

    return {
      accountId,
      oldState,
      newState: await ctx.store.getState(accountId, VACATION),
      created: null,
      updated: Object.keys(updated).length > 0 ? updated : null,
      destroyed: null,
      notCreated: singleton(
        Object.keys(args.create ?? {}),
        'There is one vacation response, and it already exists',
      ),
      notUpdated: Object.keys(notUpdated).length > 0 ? notUpdated : null,
      notDestroyed: singleton(
        args.destroy ?? [],
        'The vacation response cannot be destroyed; disable it instead',
      ),
    };
  },
};

// ------------------------------------------------------------ the reply

/** Why no reply went out, or `sent`. For logs and tests; never shown to the sender. */
export type VacationOutcome =
  | 'sent'
  | 'disabled'
  | 'outside-dates'
  | 'junk'
  | 'automatic-message'
  | 'mailing-list'
  | 'no-return-address'
  | 'not-a-person'
  | 'not-addressed-to-user'
  | 'own-address'
  | 'answered-recently';

const LIST_HEADERS = [
  'list-id',
  'list-help',
  'list-unsubscribe',
  'list-subscribe',
  'list-post',
  'list-owner',
  'list-archive',
];
/** Addresses that are programs, not people: answering them helps nobody and may loop. */
const NOT_A_PERSON =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|listserv|majordomo|.*-request|.*-bounces?|.*-owner|owner-.*)(\+.*)?@/i;

async function hashAddress(address: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(address.toLowerCase()),
  );
  return `vr${[...new Uint8Array(digest).subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Sends the account's vacation response to the sender of a message that has
 * just been delivered, when one is due. Returns what was decided.
 */
export async function sendVacationReply(
  ctx: MethodContext,
  message: ParsedMessage,
  delivery: { keywords: Record<string, true>; now?: Date },
): Promise<VacationOutcome> {
  const { transport } = ctx.mail;
  if (!transport) return 'disabled';
  const settings = await load(ctx);
  const { value } = settings;
  if (!value.isEnabled) return 'disabled';

  const now = delivery.now ?? new Date();
  if (
    (value.fromDate !== null && now.getTime() < Date.parse(value.fromDate)) ||
    (value.toDate !== null && now.getTime() >= Date.parse(value.toDate))
  ) {
    return 'outside-dates';
  }
  if (delivery.keywords['$junk']) return 'junk';

  const { headers } = message.metadata;
  const header = (name: string) =>
    headerValues(headers, name)
      .map((text) => text.replace(/\r?\n/g, ' ').trim().toLowerCase())
      .at(-1);

  // RFC 3834 §2: never answer what was itself sent automatically, or a list.
  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted !== undefined && !/^no\b/.test(autoSubmitted)) {
    return 'automatic-message';
  }
  if (
    /\b(all|oof|autoreply)\b/.test(header('x-auto-response-suppress') ?? '')
  ) {
    return 'automatic-message';
  }
  if (/^(bulk|junk|list)\b/.test(header('precedence') ?? '')) {
    return 'mailing-list';
  }
  if (LIST_HEADERS.some((name) => header(name) !== undefined)) {
    return 'mailing-list';
  }

  // RFC 3834 §4: answer the envelope sender, which the receiving server records
  // in Return-Path. An empty one marks a bounce, which must never be answered.
  const returnPath = headerValues(headers, 'return-path').at(-1);
  let target: string | undefined;
  if (returnPath !== undefined) {
    target = addressParser(returnPath.trim(), { flatten: true })[0]?.address;
    if (!target) return 'no-return-address';
  } else {
    target = message.metadata.from?.[0]?.email;
  }
  if (!target || !isValidAddress(target)) return 'no-return-address';
  if (NOT_A_PERSON.test(target)) return 'not-a-person';

  // RFC 3834 §2: only when the message names the user as a recipient, not for
  // mail that arrived through a list, an alias elsewhere or a blind copy.
  const identities = await ctx.mail.identities();
  const recipients = [
    ...(message.metadata.to ?? []),
    ...(message.metadata.cc ?? []),
  ];
  let sender: { email: string; name: string } | undefined;
  for (const recipient of recipients) {
    const identity = identities.find((candidate) =>
      identityAllows(candidate, recipient.email),
    );
    if (identity && isValidAddress(recipient.email)) {
      sender = { email: recipient.email, name: identity.name };
      break;
    }
  }
  if (!sender) return 'not-addressed-to-user';
  if (identities.some((identity) => identityAllows(identity, target))) {
    return 'own-address';
  }

  // One reply per sender per week, and again when the response itself changes.
  const repliedId = await hashAddress(target);
  const [replied] = await ctx.store.get(ctx.auth.accountId, VACATION_REPLIED, [
    repliedId,
  ]);
  const last = replied?.value as { at: string; settings: number } | undefined;
  if (
    last &&
    last.settings === settings.version &&
    now.getTime() - Date.parse(last.at) < REPLY_INTERVAL_MS
  ) {
    return 'answered-recently';
  }
  const mark = { at: toUtcDate(now), settings: settings.version };
  try {
    // Recorded before sending: two deliveries at once then send one reply, not two.
    await ctx.store.commit(ctx.auth.accountId, [
      replied
        ? {
            kind: 'update',
            type: VACATION_REPLIED,
            id: repliedId,
            value: mark,
            expectedVersion: replied.version,
          }
        : {
            kind: 'create',
            type: VACATION_REPLIED,
            id: repliedId,
            value: mark,
          },
    ]);
  } catch (error) {
    if (error instanceof ConflictError) return 'answered-recently';
    throw error;
  }

  const originalSubject = message.metadata.subject?.trim();
  const subject =
    value.subject ??
    (originalSubject ? `Auto: ${originalSubject}` : 'Automatic reply');
  const text =
    value.textBody ??
    (value.htmlBody !== null
      ? htmlToText(value.htmlBody)
          .replace(/[ \t]+/g, ' ')
          .trim()
      : DEFAULT_BODY);
  const encoder = new TextEncoder();
  const textPart: ComposePart = {
    type: 'text/plain',
    charset: 'utf-8',
    content: encoder.encode(text.replace(/\r?\n/g, '\r\n')),
  };
  const body: ComposePart =
    value.htmlBody === null
      ? textPart
      : {
          type: 'multipart/alternative',
          subParts: [
            textPart,
            {
              type: 'text/html',
              charset: 'utf-8',
              content: encoder.encode(value.htmlBody.replace(/\r?\n/g, '\r\n')),
            },
          ],
        };

  const messageIds = message.metadata.messageId ?? [];
  const references = [
    ...(message.metadata.references ?? []),
    ...messageIds,
  ].slice(-20);
  const validIds = (ids: string[]) => ids.filter((id) => /^[^\s<>]+$/.test(id));
  const domain = sender.email.slice(sender.email.lastIndexOf('@') + 1);
  const raw = composeMessage(
    [
      {
        name: 'From',
        value: formatAddresses([
          { name: sender.name || null, email: sender.email },
        ]),
      },
      { name: 'To', value: target },
      { name: 'Subject', value: encodeText(subject.replace(/[\r\n]+/g, ' ')) },
      { name: 'Date', value: formatDate(now) },
      { name: 'Message-ID', value: `<${crypto.randomUUID()}@${domain}>` },
      ...(validIds(messageIds).length > 0
        ? [
            {
              name: 'In-Reply-To',
              value: formatMessageIds(validIds(messageIds).slice(0, 1)),
            },
            {
              name: 'References',
              value: formatMessageIds(validIds(references)),
            },
          ]
        : []),
      // Tells other automatic senders not to answer this in turn.
      { name: 'Auto-Submitted', value: 'auto-replied' },
      { name: 'X-Auto-Response-Suppress', value: 'All' },
    ],
    body,
  );
  await transport.send(raw, {
    mailFrom: sender.email,
    rcptTo: [target],
    tags: { account: ctx.auth.accountId },
  });
  return 'sent';
}
