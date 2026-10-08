import {
  applyPatch,
  GetArgumentsSchema,
  MethodError,
  PatchError,
  QueryArgumentsSchema,
  QueryChangesArgumentsSchema,
  SetArgumentsSchema,
  SetFailure,
  type Comparator,
  type DeliveryStatus,
  type EmailAddress,
  type Identity,
  type SetError,
} from '@mailless/jmap-core';
import { z } from 'zod';
import { MailRejectedError } from './transport.js';
import { isValidAddress, removeHeader } from './compose.js';
import { runEmailSet } from './email.js';
import { getEmail, mutateThread } from './email-store.js';
import { asJson } from './model.js';

import {
  changesSince,
  commit,
  compareStrings,
  filterAndSort,
  fingerprint,
  generateId,
  loadForGet,
  paginate,
  parseArguments,
  pick,
  queryChanges,
  requireAccount,
  resolveCreationReference,
  retryOnConflict,
  selectProperties,
  standardChanges,
  standardSet,
  toChangesResponse,
  toUtcDate,
  type CompareFn,
  type MethodContext,
  type MethodHandler,
  type QuerySpec,
  type SetSpec,
  type StoredRecord,
} from '@mailless/jmap-engine';
import { type ResolvedIdentity } from './context.js';
export const SUBMISSION = 'EmailSubmission';
/** SES accepts at most 50 recipients per message; other transports are more generous. */
export const MAX_RECIPIENTS = 50;

type SubmissionValue = {
  identityId: string;
  emailId: string;
  threadId: string;
  envelope: {
    mailFrom: {
      email: string;
      parameters: Record<string, string | null> | null;
    };
    rcptTo: Array<{ email: string; parameters: null }>;
  };
  sendAt: string;
  undoStatus: 'pending' | 'final' | 'canceled';
  deliveryStatus: Record<string, DeliveryStatus>;
  dsnBlobIds: string[];
  mdnBlobIds: string[];
  /**
   * Present while the message has not gone out: where it is kept, and since
   * when someone has been sending it. Not shown to clients.
   */
  held?: { blobId: string; claimedAt?: string };
};
type SubmissionRecord = StoredRecord<SubmissionValue>;
type SubmissionItem = SubmissionValue & { id: string };

// ------------------------------------------------------------------ Identity

const IDENTITY_PROPERTIES = [
  'id',
  'name',
  'email',
  'replyTo',
  'bcc',
  'textSignature',
  'htmlSignature',
  'mayDelete',
];

/** What a user may change about an identity; the rest comes from the server's configuration. */
export const IDENTITY_SETTINGS = 'IdentitySettings';
const EDITABLE_IDENTITY_PROPERTIES = [
  'name',
  'replyTo',
  'bcc',
  'textSignature',
  'htmlSignature',
] as const;
const MAX_SIGNATURE_LENGTH = 20_000;

function isAddressList(value: unknown): boolean {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length <= 20 &&
      value.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          Object.keys(item).every((key) => key === 'name' || key === 'email') &&
          typeof (item as EmailAddress).email === 'string' &&
          isValidAddress((item as EmailAddress).email) &&
          ((item as EmailAddress).name === null ||
            (item as EmailAddress).name === undefined ||
            (typeof (item as EmailAddress).name === 'string' &&
              !/[\r\n]/.test((item as EmailAddress).name as string))),
      ))
  );
}

async function updateIdentity(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const identity = (await ctx.mail.identities()).find(
    (candidate) => candidate.id === id,
  );
  if (!identity) throw new SetFailure('notFound');

  const { allowedFrom: _allowedFrom, ...current } = identity;
  let next: Identity;
  try {
    next = applyPatch({ ...current }, patch);
  } catch (error) {
    if (error instanceof PatchError) {
      throw new SetFailure('invalidPatch', error.message);
    }
    throw error;
  }

  const refused = Object.keys(next).filter((property) => {
    const value = (next as unknown as Record<string, unknown>)[property];
    switch (property) {
      case 'name':
        return (
          typeof value !== 'string' ||
          value.length > 255 ||
          /[\r\n]/.test(value)
        );
      case 'replyTo':
      case 'bcc':
        return !isAddressList(value);
      case 'textSignature':
      case 'htmlSignature':
        return typeof value !== 'string' || value.length > MAX_SIGNATURE_LENGTH;
      default:
        // Everything else is fixed, but may be sent back unchanged.
        return (
          JSON.stringify(value) !==
          JSON.stringify(
            (current as unknown as Record<string, unknown>)[property],
          )
        );
    }
  });
  if (refused.length > 0) {
    throw new SetFailure('invalidProperties', undefined, {
      properties: refused,
    });
  }

  const settings = Object.fromEntries(
    EDITABLE_IDENTITY_PROPERTIES.map((property) => [property, next[property]]),
  );
  await retryOnConflict(async () => {
    const [record] = await ctx.store.get(
      ctx.auth.accountId,
      IDENTITY_SETTINGS,
      [id],
    );
    await ctx.store.commit(ctx.auth.accountId, [
      record
        ? {
            kind: 'update',
            type: IDENTITY_SETTINGS,
            id,
            value: settings,
            expectedVersion: record.version,
          }
        : { kind: 'create', type: IDENTITY_SETTINGS, id, value: settings },
    ]);
  });
}

function identityState(identities: readonly Identity[]): string {
  return fingerprint(JSON.stringify(identities));
}

/** Whether an identity may be used to send as this address; `*@domain` covers the whole domain. */
export function identityAllows(
  identity: ResolvedIdentity,
  email: string,
): boolean {
  const address = email.toLowerCase();
  const at = address.lastIndexOf('@');
  return [identity.email, ...identity.allowedFrom].some((pattern) => {
    const allowed = pattern.toLowerCase();
    return allowed.startsWith('*@')
      ? at > 0 && address.slice(at) === allowed.slice(1)
      : address === allowed;
  });
}

// ---------------------------------------------------------- EmailSubmission

function invalid(properties: string[], description: string): SetFailure {
  return new SetFailure('invalidProperties', description, { properties });
}

const EnvelopeSchema = z.strictObject({
  mailFrom: z.looseObject({
    email: z.string(),
    parameters: z.record(z.string(), z.string().nullable()).nullish(),
  }),
  rcptTo: z.array(z.looseObject({ email: z.string() })),
});

async function createSubmission(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  const transport = ctx.mail.transport;
  if (!transport)
    throw new SetFailure('forbiddenToSend', 'Sending is not configured');

  const unknown = Object.keys(input).filter(
    (property) => !['identityId', 'emailId', 'envelope'].includes(property),
  );
  if (unknown.length > 0) {
    throw invalid(unknown, 'These properties cannot be set on a submission');
  }

  const identity = (await ctx.mail.identities()).find(
    (candidate) => candidate.id === input['identityId'],
  );
  if (!identity) throw invalid(['identityId'], 'Unknown identity');

  const emailId =
    typeof input['emailId'] === 'string'
      ? resolveCreationReference(ctx, input['emailId'])
      : undefined;
  const email =
    emailId === undefined ? undefined : await getEmail(ctx, emailId);
  if (!email) throw invalid(['emailId'], 'Unknown email');

  const from = email.value.from ?? [];
  if (from.length === 0) {
    throw new SetFailure('invalidEmail', 'The email has no From address', {
      properties: ['from'],
    });
  }
  // "*@domain" means "any address here" in an identity. As a sender it is a placeholder
  // that was never filled in, and mail from it is treated as spam.
  if (from.some((address) => address.email.startsWith('*@'))) {
    throw new SetFailure(
      'invalidEmail',
      'The From address is a wildcard, not a real address',
      { properties: ['from'] },
    );
  }
  if (!from.every((address) => identityAllows(identity, address.email))) {
    throw new SetFailure(
      'forbiddenFrom',
      'The From address is not one this identity may send as',
    );
  }
  // The Sender header names who actually sent the message, so it is held to the same rule.
  if (
    !(email.value.sender ?? []).every(
      (address) =>
        !address.email.startsWith('*@') &&
        identityAllows(identity, address.email),
    )
  ) {
    throw new SetFailure(
      'forbiddenFrom',
      'The Sender address is not one this identity may send as',
    );
  }

  let mailFrom: string;
  let recipients: string[];
  let mailFromParameters: Record<string, string | null> | null = null;
  if (input['envelope'] !== undefined && input['envelope'] !== null) {
    const envelope = EnvelopeSchema.safeParse(input['envelope']);
    if (!envelope.success) throw invalid(['envelope'], 'Malformed envelope');
    mailFrom = envelope.data.mailFrom.email;
    mailFromParameters = envelope.data.mailFrom.parameters ?? null;
    recipients = envelope.data.rcptTo.map((recipient) => recipient.email);
    if (!identityAllows(identity, mailFrom)) {
      throw new SetFailure(
        'forbiddenMailFrom',
        'The envelope sender is not one this identity may send as',
      );
    }
  } else {
    mailFrom = (from[0] as { email: string }).email;
    recipients = [
      ...(email.value.to ?? []),
      ...(email.value.cc ?? []),
      ...(email.value.bcc ?? []),
    ].map((address) => address.email);
  }

  const rcptTo = [...new Set(recipients.map((address) => address.trim()))];
  if (rcptTo.length === 0) throw new SetFailure('noRecipients');
  const badRecipients = rcptTo.filter((address) => !isValidAddress(address));
  if (badRecipients.length > 0) {
    throw new SetFailure('invalidRecipients', undefined, {
      invalidRecipients: badRecipients,
    });
  }
  if (rcptTo.length > MAX_RECIPIENTS) {
    throw new SetFailure('tooManyRecipients', undefined, {
      maxRecipients: MAX_RECIPIENTS,
    });
  }

  const holdUntil = holdTime(mailFromParameters, ctx, new Date());

  const raw = await ctx.blobs.get(ctx.auth.accountId, email.value.blobId);
  if (!raw) throw invalid(['emailId'], 'The content of the email is missing');
  // Bcc recipients are in the envelope; the header must not travel with the message.
  const message = removeHeader(raw, 'Bcc');

  const id = generateId('es');
  const base = {
    identityId: identity.id,
    emailId: email.id,
    threadId: email.value.threadId,
    envelope: {
      mailFrom: { email: mailFrom, parameters: mailFromParameters },
      rcptTo: rcptTo.map((address) => ({ email: address, parameters: null })),
    },
    dsnBlobIds: [],
    mdnBlobIds: [],
  };
  const statusFor = (smtpReply: string) =>
    Object.fromEntries(
      rcptTo.map((address): [string, DeliveryStatus] => [
        address,
        { smtpReply, delivered: 'queued', displayed: 'unknown' },
      ]),
    );

  let value: SubmissionValue;
  if (holdUntil && ctx.mail.scheduler) {
    // Kept apart from the email, which may be changed or destroyed before the
    // time comes without that changing what is sent (RFC 8621 §7.5).
    const blobId = generateId('bh');
    await ctx.blobs.put(ctx.auth.accountId, blobId, message);
    value = {
      ...base,
      sendAt: toUtcDate(holdUntil),
      undoStatus: 'pending',
      deliveryStatus: statusFor('250 2.0.0 Held for later delivery'),
      held: { blobId },
    };
    await commit(ctx, [
      { kind: 'create', type: SUBMISSION, id, value: asJson(value) },
    ]);
    try {
      await ctx.mail.scheduler.schedule({
        accountId: ctx.auth.accountId,
        submissionId: id,
        sendAt: holdUntil,
      });
    } catch (error) {
      // Nothing will wake up to send it, so it must not look as if it were held.
      await ctx.store
        .commit(ctx.auth.accountId, [{ kind: 'destroy', type: SUBMISSION, id }])
        .catch(() => undefined);
      await ctx.blobs.delete(ctx.auth.accountId, blobId).catch(() => undefined);
      throw error;
    }
  } else {
    let receipt;
    try {
      receipt = await transport.send(message, {
        mailFrom,
        rcptTo,
        // Lets delivery events find their way back to this submission.
        tags: { account: ctx.auth.accountId, submission: id },
      });
    } catch (error) {
      if (error instanceof MailRejectedError) {
        throw new SetFailure('forbiddenToSend', error.message);
      }
      throw error;
    }
    await rememberTransportIds(ctx, base, receipt?.messageIds ?? []);
    value = {
      ...base,
      sendAt: toUtcDate(new Date()),
      undoStatus: 'final',
      // Accepted by the transport; what happens next arrives through recordDelivery.
      deliveryStatus: statusFor('250 Accepted'),
    };
    await commit(ctx, [
      { kind: 'create', type: SUBMISSION, id, value: asJson(value) },
    ]);
  }

  // Everything the client did not send itself.
  return {
    id,
    threadId: value.threadId,
    sendAt: value.sendAt,
    undoStatus: value.undoStatus,
    deliveryStatus: value.deliveryStatus,
    dsnBlobIds: value.dsnBlobIds,
    mdnBlobIds: value.mdnBlobIds,
    ...(input['envelope'] ? {} : { envelope: value.envelope }),
  };
}

/**
 * Notes the ids the transport gave a message on the email it was sent from,
 * so that replies find their thread. The email may be gone by now.
 */
async function rememberTransportIds(
  ctx: MethodContext,
  submission: { emailId: string; threadId: string },
  transportMessageIds: string[],
): Promise<void> {
  if (transportMessageIds.length === 0) return;
  try {
    await mutateThread(ctx, submission.threadId, (emails) => {
      const current = emails.find(
        (candidate) => candidate.id === submission.emailId,
      );
      if (!current) return [];
      return [
        {
          kind: 'update',
          id: current.id,
          value: {
            ...current.value,
            transportMessageIds: [
              ...new Set([
                ...(current.value.transportMessageIds ?? []),
                ...transportMessageIds,
              ]),
            ],
          },
          changedProperties: [],
        },
      ];
    });
  } catch {
    // The message has gone out. Failing now would invite the client to send it again,
    // which is far worse than a reply landing in a thread of its own.
  }
}

/** How long one attempt to send a held message is given before another may take over. */
const CLAIM_MS = 2 * 60 * 1000;
/** A message asked to be held for less than this is simply sent. */
const MIN_HOLD_MS = 2000;

/**
 * When to send, from the FUTURERELEASE parameters of the envelope sender
 * (RFC 4865): `HOLDFOR` in seconds, or `HOLDUNTIL` as a date. Undefined when
 * the message is to go now.
 */
function holdTime(
  parameters: Record<string, string | null> | null,
  ctx: MethodContext,
  now: Date,
): Date | undefined {
  const given = Object.entries(parameters ?? {}).filter(([name]) =>
    ['holdfor', 'holduntil'].includes(name.toLowerCase()),
  );
  if (given.length === 0) return undefined;
  const refuse = (description: string): never => {
    throw invalid(['envelope'], description);
  };
  if (given.length > 1) refuse('Give HOLDFOR or HOLDUNTIL, not both');
  const [name, text] = given[0] as [string, string | null];

  let until: number;
  if (name.toLowerCase() === 'holdfor') {
    if (text === null || !/^\d{1,9}$/.test(text)) {
      refuse('HOLDFOR must be a number of seconds');
    }
    until = now.getTime() + Number(text) * 1000;
  } else {
    until = text === null ? NaN : Date.parse(text);
    if (
      text === null ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i.test(
        text,
      ) ||
      Number.isNaN(until)
    ) {
      refuse('HOLDUNTIL must be a date and time');
    }
  }
  if (until - now.getTime() < MIN_HOLD_MS) return undefined;
  if (!ctx.mail.scheduler || ctx.mail.maxDelayedSend === 0) {
    refuse('This server cannot hold a message to send it later');
  }
  if (until - now.getTime() > ctx.mail.maxDelayedSend * 1000) {
    refuse(
      `A message can be held for at most ${ctx.mail.maxDelayedSend} seconds`,
    );
  }
  return new Date(until);
}

/** What became of a held message when its time came. */
export type ScheduledSendOutcome =
  'sent' | 'rejected' | 'not-pending' | 'not-found' | 'in-progress';

/**
 * Sends a message that was being held, when its time has come. Safe to call
 * more than once and from several places at the same time: one caller sends,
 * the others are told there is nothing for them to do. Throws when sending
 * failed in a way worth trying again.
 */
export async function sendScheduled(
  ctx: MethodContext,
  submissionId: string,
  now: Date = new Date(),
): Promise<ScheduledSendOutcome> {
  const { transport } = ctx.mail;
  if (!transport) throw new Error('Sending is not configured');
  const accountId = ctx.auth.accountId;
  const load = async () =>
    (
      await ctx.store.get(accountId, SUBMISSION, [submissionId])
    )[0] as unknown as SubmissionRecord | undefined;

  // From here on it can no longer be cancelled: that is decided before anything
  // is sent, so a cancellation and a send can never both succeed.
  const claimed = await retryOnConflict(async () => {
    const record = await load();
    if (!record) return 'not-found' as const;
    const { held, undoStatus } = record.value;
    if (!held || undoStatus === 'canceled') return 'not-pending' as const;
    if (
      held.claimedAt !== undefined &&
      now.getTime() - Date.parse(held.claimedAt) < CLAIM_MS
    ) {
      return 'in-progress' as const;
    }
    const value: SubmissionValue = {
      ...record.value,
      undoStatus: 'final',
      held: { ...held, claimedAt: toUtcDate(now) },
    };
    await commit(ctx, [
      {
        kind: 'update',
        type: SUBMISSION,
        id: submissionId,
        value: asJson(value),
        expectedVersion: record.version,
        changedProperties: ['undoStatus'],
      },
    ]);
    return value;
  });
  if (typeof claimed === 'string') return claimed;
  const held = claimed.held as NonNullable<SubmissionValue['held']>;

  /** Records how it ended, and lets go of the kept message. */
  const finish = async (
    status: (current: DeliveryStatus) => DeliveryStatus,
  ): Promise<void> => {
    await retryOnConflict(async () => {
      const record = await load();
      if (!record) return;
      const { held: _held, ...rest } = record.value;
      await commit(ctx, [
        {
          kind: 'update',
          type: SUBMISSION,
          id: submissionId,
          value: asJson({
            ...rest,
            deliveryStatus: Object.fromEntries(
              Object.entries(rest.deliveryStatus).map(([address, current]) => [
                address,
                status(current),
              ]),
            ),
          }),
          expectedVersion: record.version,
          changedProperties: ['deliveryStatus'],
        },
      ]);
    });
    await ctx.blobs.delete(accountId, held.blobId).catch(() => undefined);
  };

  const message = await ctx.blobs.get(accountId, held.blobId);
  if (!message) {
    await finish((current) => ({
      ...current,
      delivered: 'no',
      smtpReply: '554 5.3.0 The message to send was lost',
    }));
    return 'rejected';
  }

  let receipt;
  try {
    receipt = await transport.send(message, {
      mailFrom: claimed.envelope.mailFrom.email,
      rcptTo: claimed.envelope.rcptTo.map((recipient) => recipient.email),
      tags: { account: accountId, submission: submissionId },
    });
  } catch (error) {
    if (error instanceof MailRejectedError) {
      const reason = error.message.replace(/[\r\n]+/g, ' ');
      await finish((current) => ({
        ...current,
        delivered: 'no',
        smtpReply: `550 5.0.0 ${reason}`,
      }));
      return 'rejected';
    }
    // Worth another try: step back, so that whoever calls next may send.
    await retryOnConflict(async () => {
      const record = await load();
      if (!record?.value.held) return;
      await commit(ctx, [
        {
          kind: 'update',
          type: SUBMISSION,
          id: submissionId,
          value: asJson({
            ...record.value,
            held: { blobId: record.value.held.blobId },
          }),
          expectedVersion: record.version,
          changedProperties: [],
        },
      ]);
    });
    throw error;
  }

  await finish((current) => ({ ...current, smtpReply: '250 Accepted' }));
  await rememberTransportIds(ctx, claimed, receipt?.messageIds ?? []);
  return 'sent';
}

/** Cancels a held message, if it has not started going out. */
async function updateSubmission(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<null> {
  const refused = Object.keys(patch).filter(
    (property) => property !== 'undoStatus',
  );
  if (refused.length > 0) {
    throw invalid(refused, 'Only undoStatus can be changed');
  }
  const cancelled = await retryOnConflict(async () => {
    const [record] = (await ctx.store.get(ctx.auth.accountId, SUBMISSION, [
      id,
    ])) as unknown as SubmissionRecord[];
    if (!record) throw new SetFailure('notFound');
    const { held, undoStatus } = record.value;
    // Setting it to what it is already changes nothing, and is not an error.
    if (!('undoStatus' in patch) || patch['undoStatus'] === undoStatus) {
      return undefined;
    }
    if (patch['undoStatus'] !== 'canceled') {
      throw invalid(['undoStatus'], 'undoStatus can only be set to "canceled"');
    }
    if (undoStatus !== 'pending' || !held || held.claimedAt !== undefined) {
      throw new SetFailure('cannotUnsend', 'The message has already been sent');
    }
    const { held: _held, ...rest } = record.value;
    await commit(ctx, [
      {
        kind: 'update',
        type: SUBMISSION,
        id,
        value: asJson({
          ...rest,
          undoStatus: 'canceled',
          deliveryStatus: Object.fromEntries(
            Object.entries(rest.deliveryStatus).map(([address, current]) => [
              address,
              {
                ...current,
                delivered: 'no',
                smtpReply: '554 5.0.0 Canceled before it was sent',
              },
            ]),
          ),
        }),
        expectedVersion: record.version,
        changedProperties: ['undoStatus', 'deliveryStatus'],
      },
    ]);
    return held;
  });
  if (cancelled) {
    await ctx.blobs
      .delete(ctx.auth.accountId, cancelled.blobId)
      .catch(() => undefined);
    await ctx.mail.scheduler
      ?.cancel?.({ accountId: ctx.auth.accountId, submissionId: id })
      .catch(() => undefined);
  }
  return null;
}

const submissionSetSpec: SetSpec = {
  type: SUBMISSION,
  create: createSubmission,
  update: updateSubmission,
  destroy: async (ctx, id) => {
    const [record] = await ctx.store.get(ctx.auth.accountId, SUBMISSION, [id]);
    if (!record) throw new SetFailure('notFound');
    // The record is what the held message is sent from. Forgetting it would
    // either lose the message or send it with nothing left to cancel.
    if ((record.value as SubmissionValue).held) {
      throw new SetFailure(
        'forbidden',
        'This message is still waiting to be sent; cancel it first',
      );
    }
    await commit(ctx, [
      {
        kind: 'destroy',
        type: SUBMISSION,
        id,
        expectedVersion: record.version,
      },
    ]);
  },
};

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isDate = (value: unknown): boolean =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const CONDITIONS: Record<
  string,
  {
    valid(value: unknown): boolean;
    matches(item: SubmissionItem, value: unknown): boolean;
  }
> = {
  identityIds: {
    valid: isStringArray,
    matches: (item, value) => (value as string[]).includes(item.identityId),
  },
  emailIds: {
    valid: isStringArray,
    matches: (item, value) => (value as string[]).includes(item.emailId),
  },
  threadIds: {
    valid: isStringArray,
    matches: (item, value) => (value as string[]).includes(item.threadId),
  },
  undoStatus: {
    valid: (value) => typeof value === 'string',
    matches: (item, value) => item.undoStatus === value,
  },
  before: {
    valid: isDate,
    matches: (item, value) =>
      Date.parse(item.sendAt) < Date.parse(value as string),
  },
  after: {
    valid: isDate,
    matches: (item, value) =>
      Date.parse(item.sendAt) >= Date.parse(value as string),
  },
};

const submissionQuerySpec: QuerySpec<SubmissionItem> = {
  validateCondition(condition) {
    for (const [key, value] of Object.entries(condition)) {
      const rule = CONDITIONS[key];
      if (!rule || !rule.valid(value)) {
        throw new MethodError(
          'invalidArguments',
          `Invalid EmailSubmission filter property "${key}"`,
        );
      }
    }
  },
  matches(item, condition) {
    return Object.entries(condition).every(([key, value]) =>
      CONDITIONS[key]?.matches(item, value),
    );
  },
  comparator(comparator: Comparator): CompareFn<SubmissionItem> {
    switch (comparator.property) {
      case 'sentAt':
        return (a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt);
      case 'emailId':
        return (a, b) => compareStrings(a.emailId, b.emailId);
      case 'threadId':
        return (a, b) => compareStrings(a.threadId, b.threadId);
      default:
        throw new MethodError(
          'unsupportedSort',
          `Submissions cannot be sorted by "${comparator.property}"`,
        );
    }
  },
};

const SUBMISSION_PROPERTIES = [
  'id',
  'identityId',
  'emailId',
  'threadId',
  'envelope',
  'sendAt',
  'undoStatus',
  'deliveryStatus',
  'dsnBlobIds',
  'mdnBlobIds',
];

const SubmissionSetArgumentsSchema = SetArgumentsSchema.extend({
  onSuccessUpdateEmail: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .nullish(),
  onSuccessDestroyEmail: z.array(z.string()).nullish(),
});

/** The ids an EmailSubmission/query with these arguments finds now, in order. */
async function querySubmissionIds(
  ctx: MethodContext,
  args: {
    filter?: Record<string, unknown> | null | undefined;
    sort?: Comparator[] | null | undefined;
  },
): Promise<string[]> {
  const records = (await ctx.store.list(
    ctx.auth.accountId,
    SUBMISSION,
  )) as unknown as SubmissionRecord[];
  return filterAndSort(
    records.map((record) => ({ id: record.id, ...record.value })),
    args.filter,
    args.sort,
    submissionQuerySpec,
  ).map((item) => item.id);
}

export const submissionMethods: Record<string, MethodHandler> = {
  'Identity/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, IDENTITY_PROPERTIES);
    const identities = await ctx.mail.identities();
    const wanted = args.ids ?? identities.map((identity) => identity.id);
    const byId = new Map(identities.map((identity) => [identity.id, identity]));
    return {
      accountId,
      state: identityState(identities),
      list: wanted.flatMap((id) => {
        const identity = byId.get(id);
        return identity ? [pick({ ...identity }, properties)] : [];
      }),
      notFound: wanted.filter((id) => !byId.has(id)),
    };
  },

  'Identity/changes': async (rawArgs, ctx) => {
    const args = parseArguments(
      z.strictObject({
        accountId: z.string(),
        sinceState: z.string(),
        maxChanges: z.number().int().min(1).nullish(),
      }),
      rawArgs,
    );
    const accountId = requireAccount(ctx, args.accountId);
    const state = identityState(await ctx.mail.identities());
    // Identities come from configuration, so there is no history to replay.
    if (args.sinceState !== state)
      throw new MethodError('cannotCalculateChanges');
    return {
      accountId,
      oldState: state,
      newState: state,
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: [],
    };
  },

  'Identity/set': async (rawArgs, ctx) => {
    const args = parseArguments(SetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const oldState = identityState(await ctx.mail.identities());
    if (args.ifInState && args.ifInState !== oldState) {
      throw new MethodError('stateMismatch');
    }
    const update = Object.entries(args.update ?? {});
    if (
      Object.keys(args.create ?? {}).length +
        update.length +
        (args.destroy ?? []).length >
      ctx.limits.maxObjectsInSet
    ) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInSet} objects may be changed in one call`,
      );
    }
    // Which identities exist, and their addresses, is the server's decision.
    const refuse = (keys: string[], description: string) =>
      keys.length === 0
        ? null
        : Object.fromEntries(
            keys.map((key) => [key, { type: 'forbidden', description }]),
          );

    const updated: Record<string, null> = {};
    const notUpdated: Record<string, SetError> = {};
    for (const [id, patch] of update) {
      try {
        if ((args.destroy ?? []).includes(id)) {
          throw new SetFailure('willDestroy');
        }
        await updateIdentity(ctx, id, patch);
        updated[id] = null;
      } catch (error) {
        if (!(error instanceof SetFailure)) throw error;
        notUpdated[id] = error.error;
      }
    }

    return {
      accountId,
      oldState,
      newState: identityState(await ctx.mail.identities()),
      created: null,
      updated: Object.keys(updated).length > 0 ? updated : null,
      destroyed: null,
      notCreated: refuse(
        Object.keys(args.create ?? {}),
        'The addresses an account may send from are set by the server',
      ),
      notUpdated: Object.keys(notUpdated).length > 0 ? notUpdated : null,
      notDestroyed: refuse(
        args.destroy ?? [],
        'This identity cannot be deleted',
      ),
    };
  },

  'EmailSubmission/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, SUBMISSION_PROPERTIES);
    const { state, records, notFound } = await loadForGet(
      ctx,
      SUBMISSION,
      args.ids,
    );
    return {
      accountId,
      state,
      list: (records as unknown as SubmissionRecord[]).map((record) =>
        pick({ id: record.id, ...record.value }, properties),
      ),
      notFound,
    };
  },

  'EmailSubmission/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, SUBMISSION, rawArgs)),
  }),

  'EmailSubmission/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(QueryChangesArgumentsSchema, rawArgs);
    requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(ctx.auth.accountId, SUBMISSION);
    const changes = await changesSince(ctx, SUBMISSION, args.sinceQueryState);
    const ids = await querySubmissionIds(ctx, args);
    return { ...queryChanges(ctx, ids, changes, [], args, state) };
  },

  'EmailSubmission/query': async (rawArgs, ctx) => {
    const args = parseArguments(QueryArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, SUBMISSION);
    const ids = await querySubmissionIds(ctx, args);
    return { ...paginate(ctx, ids, args, state) };
  },

  'EmailSubmission/set': async (rawArgs, ctx) => {
    const args = parseArguments(SubmissionSetArgumentsSchema, rawArgs);
    const { onSuccessUpdateEmail, onSuccessDestroyEmail, ...setArgs } = args;

    // Which email each submission is for, read before any of them is destroyed.
    const emailOf = new Map<string, string>();
    const existing = [
      ...Object.keys(setArgs.update ?? {}),
      ...(setArgs.destroy ?? []),
    ];
    if (existing.length > 0) {
      for (const record of (await ctx.store.get(
        ctx.auth.accountId,
        SUBMISSION,
        existing,
      )) as unknown as SubmissionRecord[]) {
        emailOf.set(record.id, record.value.emailId);
      }
    }

    const result = await standardSet(ctx, submissionSetSpec, setArgs);

    // "#creationId" and plain ids of submissions that succeeded in this call, mapped to their email.
    const sent = new Map<string, string>();
    for (const [creationId, created] of Object.entries(result.created ?? {})) {
      const record = (
        await ctx.store.get(ctx.auth.accountId, SUBMISSION, [
          created['id'] as string,
        ])
      )[0] as unknown as SubmissionRecord | undefined;
      if (record) {
        sent.set(`#${creationId}`, record.value.emailId);
        sent.set(record.id, record.value.emailId);
      }
    }
    for (const id of [
      ...Object.keys(result.updated ?? {}),
      ...(result.destroyed ?? []),
    ]) {
      const emailId = emailOf.get(id);
      if (emailId) sent.set(id, emailId);
    }

    const update: Record<string, Record<string, unknown>> = {};
    for (const [reference, patch] of Object.entries(
      onSuccessUpdateEmail ?? {},
    )) {
      const emailId = sent.get(reference);
      if (emailId) update[emailId] = patch;
    }
    const destroy = (onSuccessDestroyEmail ?? []).flatMap((reference) => {
      const emailId = sent.get(reference);
      return emailId ? [emailId] : [];
    });

    if (Object.keys(update).length > 0 || destroy.length > 0) {
      ctx.extraResponses.push([
        'Email/set',
        {
          ...(await runEmailSet(ctx, {
            accountId: args.accountId,
            update,
            destroy,
          })),
        },
      ]);
    }
    return { ...result };
  },
};

/** What became of a message for one recipient, as reported by the transport afterwards. */
export interface DeliveryUpdate {
  delivered: DeliveryStatus['delivered'];
  smtpReply?: string;
}

// A failure is final, and a late "queued" must not undo a known outcome.
const CERTAINTY: Record<DeliveryStatus['delivered'], number> = {
  unknown: 0,
  queued: 1,
  yes: 2,
  no: 3,
};

/**
 * Records delivery outcomes on a submission. Recipients are matched without
 * regard to case; unknown ones are ignored. Returns false when the submission
 * does not exist.
 */
export async function recordDelivery(
  ctx: MethodContext,
  submissionId: string,
  updates: Record<string, DeliveryUpdate>,
): Promise<boolean> {
  return retryOnConflict(async () => {
    const [record] = (await ctx.store.get(ctx.auth.accountId, SUBMISSION, [
      submissionId,
    ])) as unknown as SubmissionRecord[];
    if (!record) return false;

    const deliveryStatus = { ...record.value.deliveryStatus };
    let changed = false;
    for (const [recipient, update] of Object.entries(updates)) {
      const key = Object.keys(deliveryStatus).find(
        (candidate) => candidate.toLowerCase() === recipient.toLowerCase(),
      );
      const current = key === undefined ? undefined : deliveryStatus[key];
      if (key === undefined || !current) continue;
      if (CERTAINTY[update.delivered] < CERTAINTY[current.delivered]) continue;

      const next = {
        ...current,
        delivered: update.delivered,
        ...(update.smtpReply === undefined
          ? {}
          : { smtpReply: update.smtpReply }),
      };
      if (
        next.delivered !== current.delivered ||
        next.smtpReply !== current.smtpReply
      ) {
        deliveryStatus[key] = next;
        changed = true;
      }
    }
    if (!changed) return true;

    await commit(ctx, [
      {
        kind: 'update',
        type: SUBMISSION,
        id: submissionId,
        value: asJson({ ...record.value, deliveryStatus }),
        expectedVersion: record.version,
        changedProperties: ['deliveryStatus'],
      },
    ]);
    return true;
  });
}
