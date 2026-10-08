import {
  CAPABILITY_MDN,
  IdSchema,
  MethodError,
  SetFailure,
  type SetError,
} from '@mailless/jmap-core';
import { addressParser } from 'postal-mime';
import { z } from 'zod';
import { MailRejectedError } from './transport.js';
import {
  composeMessage,
  encodeText,
  formatAddresses,
  formatDate,
  formatMessageIds,
  isValidAddress,
  type ComposePart,
} from './compose.js';
import { readBlob, runEmailSet } from './email.js';
import { getEmail } from './email-store.js';
import { headerValues } from './headers.js';
import {
  InvalidMessageError,
  parseMessage,
  partText,
  type ParsedPart,
} from './mime.js';
import { EMAIL, type EmailRecord } from './model.js';
import { identityAllows } from './submission.js';

import {
  parseArguments,
  requireAccount,
  type MethodContext,
  type MethodHandler,
} from '@mailless/jmap-engine';
export { CAPABILITY_MDN };

/*
 * Message disposition notifications (RFC 9007, RFC 8098): the "read receipt".
 * MDN/parse reads one that arrived; MDN/send answers a message that asked
 * for one.
 */

const ACTION_MODES = ['manual-action', 'automatic-action'];
const SENDING_MODES = ['mdn-sent-manually', 'mdn-sent-automatically'];
const TYPES = ['deleted', 'dispatched', 'displayed', 'processed'];
const MDN_PROPERTIES = [
  'forEmailId',
  'subject',
  'textBody',
  'includeOriginalMessage',
  'reportingUA',
  'disposition',
  'mdnGateway',
  'originalRecipient',
  'finalRecipient',
  'originalMessageId',
  'error',
  'extensionFields',
];
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function leaves(part: ParsedPart): ParsedPart[] {
  return part.subParts ? part.subParts.flatMap(leaves) : [part];
}

/** The fields of the machine-readable part of a notification: header lines, by lower-case name. */
function reportFields(content: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const unfolded = content.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const values = fields.get(name) ?? [];
    values.push(line.slice(colon + 1).trim());
    fields.set(name, values);
  }
  return fields;
}

/** Reads a blob as a notification, or returns null when it is not one. */
async function parseMdn(
  ctx: MethodContext,
  raw: Uint8Array,
): Promise<Record<string, unknown> | null> {
  let message;
  try {
    message = await parseMessage(raw);
  } catch (error) {
    if (error instanceof InvalidMessageError) return null;
    throw error;
  }
  if (message.structure.type !== 'multipart/report') return null;
  const parts = leaves(message.structure);
  const report = parts.find(
    (part) => part.type === 'message/disposition-notification',
  );
  if (!report) return null;

  const fields = reportFields(decoder.decode(report.data));
  const first = (name: string) => fields.get(name)?.[0] ?? null;
  // "action-mode/sending-mode; type/modifier, modifier", in any case.
  const match = /^([^/;\s]+)\s*\/\s*([^;\s]+)\s*;\s*([^/\s]+)/.exec(
    (first('disposition') ?? '').toLowerCase(),
  );
  if (!match) return null;
  const [, actionMode, sendingMode, type] = match as unknown as string[];
  if (
    !ACTION_MODES.includes(actionMode as string) ||
    !SENDING_MODES.includes(sendingMode as string) ||
    !TYPES.includes(type as string)
  ) {
    return null;
  }

  const known = new Set([
    'reporting-ua',
    'mdn-gateway',
    'original-recipient',
    'final-recipient',
    'original-message-id',
    'disposition',
    'error',
  ]);
  const extensionFields: Record<string, string> = {};
  for (const [name, values] of fields) {
    if (!known.has(name)) extensionFields[name] = values[0] as string;
  }

  const originalMessageId = first('original-message-id');
  // The message it answers, when there is exactly one with that Message-ID here.
  let forEmailId: string | null = null;
  const bare = originalMessageId?.replace(/^<|>$/g, '');
  if (bare) {
    const candidates = (
      (await ctx.store.list(ctx.auth.accountId, EMAIL, {
        name: 'threadKey',
        value: bare,
      })) as unknown as EmailRecord[]
    ).filter((email) => email.value.messageId?.includes(bare));
    if (candidates.length === 1) forEmailId = (candidates[0] as EmailRecord).id;
  }

  const text = parts.find((part) => part.type === 'text/plain');
  const reportIndex = parts.indexOf(report);
  return {
    forEmailId,
    subject: message.metadata.subject,
    textBody: text ? partText(text).value : null,
    // The third component of the report, when present, is the original or its headers.
    includeOriginalMessage: parts.length > reportIndex + 1,
    reportingUA: first('reporting-ua'),
    disposition: { actionMode, sendingMode, type },
    mdnGateway: first('mdn-gateway'),
    originalRecipient: first('original-recipient'),
    finalRecipient: first('final-recipient'),
    originalMessageId,
    error: fields.get('error') ?? null,
    extensionFields:
      Object.keys(extensionFields).length > 0 ? extensionFields : null,
  };
}

function invalid(properties: string[], description: string): SetFailure {
  return new SetFailure('invalidProperties', description, { properties });
}

const oneLine = (value: unknown): value is string =>
  typeof value === 'string' && !/[\r\n\0]/.test(value);

/** Sends one notification. Returns what the server set that the client did not. */
async function sendMdn(
  ctx: MethodContext,
  input: Record<string, unknown>,
  identityId: string,
  setsKeyword: boolean,
): Promise<Record<string, unknown>> {
  const { transport } = ctx.mail;
  if (!transport)
    throw new SetFailure('forbidden', 'Sending is not configured');

  const unknown = Object.keys(input).filter(
    (property) => !MDN_PROPERTIES.includes(property),
  );
  if (unknown.length > 0) throw invalid(unknown, 'Unknown properties');
  const serverSet = [
    'mdnGateway',
    'originalRecipient',
    'originalMessageId',
    'error',
  ].filter(
    (property) => input[property] !== undefined && input[property] !== null,
  );
  if (serverSet.length > 0) {
    throw invalid(serverSet, 'These properties are set by the server');
  }

  const disposition = input['disposition'] as Record<string, unknown> | null;
  if (
    typeof disposition !== 'object' ||
    disposition === null ||
    !ACTION_MODES.includes(disposition['actionMode'] as string) ||
    !SENDING_MODES.includes(disposition['sendingMode'] as string) ||
    !TYPES.includes(disposition['type'] as string)
  ) {
    throw invalid(['disposition'], 'disposition is not a valid Disposition');
  }
  for (const property of ['subject', 'reportingUA', 'finalRecipient']) {
    const value = input[property];
    if (value !== undefined && value !== null && !oneLine(value)) {
      throw invalid([property], `${property} must be a single line of text`);
    }
  }
  const textBody = input['textBody'] ?? null;
  if (textBody !== null && typeof textBody !== 'string') {
    throw invalid(['textBody'], 'textBody must be text');
  }
  const includeOriginal = input['includeOriginalMessage'] ?? false;
  if (typeof includeOriginal !== 'boolean') {
    throw invalid(['includeOriginalMessage'], 'Must be true or false');
  }
  const extensionFields = (input['extensionFields'] ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof extensionFields !== 'object' ||
    Array.isArray(extensionFields) ||
    !Object.entries(extensionFields).every(
      ([name, value]) => /^[\x21-\x39\x3b-\x7e]+$/.test(name) && oneLine(value),
    )
  ) {
    throw invalid(['extensionFields'], 'Must map field names to single lines');
  }

  const identity = (await ctx.mail.identities()).find(
    (candidate) => candidate.id === identityId,
  );
  if (!identity) throw new MethodError('invalidArguments', 'Unknown identity');

  const email =
    typeof input['forEmailId'] === 'string'
      ? await getEmail(ctx, input['forEmailId'])
      : undefined;
  // Only a message that asked for a notification gets one, and only where it asked.
  const askedBy = email
    ? headerValues(email.value.headers, 'disposition-notification-to').flatMap(
        (value) =>
          addressParser(value.replace(/\r?\n/g, ' '), {
            flatten: true,
          }).flatMap((address) =>
            address.address && isValidAddress(address.address)
              ? [address.address]
              : [],
          ),
      )
    : [];
  if (!email || askedBy.length === 0) throw new SetFailure('notFound');
  if (email.value.keywords['$mdnsent']) {
    throw new SetFailure('mdnAlreadySent');
  }
  // RFC 9007 §2.1: the request must also mark the message, or it is refused,
  // so that no message is answered twice.
  if (!setsKeyword) {
    throw invalid(
      ['forEmailId'],
      'onSuccessUpdateEmail must set the $mdnsent keyword on the message',
    );
  }

  let finalRecipient = `rfc822; ${identity.email}`;
  if (typeof input['finalRecipient'] === 'string') {
    const address = input['finalRecipient'].replace(/^[^;]*;\s*/, '').trim();
    if (!identityAllows(identity, address)) {
      throw new SetFailure(
        'forbiddenFrom',
        'finalRecipient is not an address this identity may answer as',
      );
    }
    finalRecipient = input['finalRecipient'];
  }
  const sender = finalRecipient.replace(/^[^;]*;\s*/, '').trim();
  if (!isValidAddress(sender) || sender.startsWith('*@')) {
    throw new SetFailure('forbiddenFrom', 'There is no address to answer from');
  }

  const originalMessageId = email.value.messageId?.[0]
    ? `<${email.value.messageId[0]}>`
    : null;
  const originalSubject = email.value.subject?.trim();
  const subject =
    (input['subject'] as string | null | undefined) ??
    (originalSubject ? `Read: ${originalSubject}` : 'Read receipt');
  const typeName = (disposition as Record<string, string>)['type'];
  const report = [
    ...(input['reportingUA'] ? [`Reporting-UA: ${input['reportingUA']}`] : []),
    `Final-Recipient: ${finalRecipient}`,
    ...(originalMessageId ? [`Original-Message-ID: ${originalMessageId}`] : []),
    `Disposition: ${(disposition as Record<string, string>)['actionMode']}/${(disposition as Record<string, string>)['sendingMode']}; ${typeName}`,
    ...Object.entries(extensionFields).map(
      ([name, value]) => `${name}: ${value as string}`,
    ),
    '',
  ].join('\r\n');

  const subParts: ComposePart[] = [
    {
      type: 'text/plain',
      charset: 'utf-8',
      content: encoder.encode(
        (
          (textBody as string | null) ??
          `This is a receipt for the message you sent to ${sender}. It was ${typeName}.`
        ).replace(/\r?\n/g, '\r\n'),
      ),
    },
    {
      type: 'message/disposition-notification',
      content: encoder.encode(report),
    },
  ];
  if (includeOriginal) {
    // The headers of the original, not its content: enough to recognise it by,
    // without sending what someone wrote back to them through a third party.
    subParts.push({
      type: 'text/rfc822-headers',
      charset: 'utf-8',
      content: encoder.encode(
        email.value.headers
          .map((header) => `${header.name}:${header.value}`)
          .join('\r\n') + '\r\n',
      ),
    });
  }

  const references = [
    ...(email.value.references ?? []),
    ...(email.value.messageId ?? []),
  ]
    .filter((id) => /^[^\s<>]+$/.test(id))
    .slice(-20);
  const domain = sender.slice(sender.lastIndexOf('@') + 1);
  const raw = composeMessage(
    [
      {
        name: 'From',
        value: formatAddresses([
          { name: identity.name || null, email: sender },
        ]),
      },
      { name: 'To', value: [...new Set(askedBy)].join(', ') },
      { name: 'Subject', value: encodeText(subject) },
      { name: 'Date', value: formatDate(new Date()) },
      { name: 'Message-ID', value: `<${crypto.randomUUID()}@${domain}>` },
      ...(references.length > 0
        ? [
            {
              name: 'In-Reply-To',
              value: formatMessageIds(references.slice(-1)),
            },
            { name: 'References', value: formatMessageIds(references) },
          ]
        : []),
      // A receipt is not something to answer automatically.
      { name: 'Auto-Submitted', value: 'auto-replied' },
    ],
    {
      type: 'multipart/report',
      parameters: { 'report-type': 'disposition-notification' },
      subParts,
    },
  );

  try {
    await transport.send(raw, {
      mailFrom: sender,
      rcptTo: [...new Set(askedBy)],
      tags: { account: ctx.auth.accountId },
    });
  } catch (error) {
    if (error instanceof MailRejectedError) {
      throw new SetFailure('forbidden', error.message);
    }
    throw error;
  }

  // Everything the client did not say itself.
  const result: Record<string, unknown> = {
    mdnGateway: null,
    originalRecipient: null,
    originalMessageId,
    error: null,
  };
  const defaults: Record<string, unknown> = {
    subject,
    textBody: null,
    includeOriginalMessage: false,
    reportingUA: null,
    finalRecipient,
    extensionFields: null,
  };
  for (const [property, value] of Object.entries(defaults)) {
    if (input[property] === undefined) result[property] = value;
  }
  return result;
}

const ParseArguments = z.strictObject({
  accountId: z.string(),
  blobIds: z.array(z.string()),
});

const SendArguments = z.strictObject({
  accountId: z.string(),
  // Required, but checked after the account: an account the user cannot use
  // is the first thing wrong with a request that names one.
  identityId: z.string().optional(),
  send: z.record(z.string(), z.record(z.string(), z.unknown())),
  onSuccessUpdateEmail: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .nullish(),
});

/** Whether a patch leaves the email with the `$mdnsent` keyword. */
function setsMdnSent(patch: Record<string, unknown> | undefined): boolean {
  if (!patch) return false;
  if (patch['keywords/$mdnsent'] === true) return true;
  const keywords = patch['keywords'];
  return (
    typeof keywords === 'object' &&
    keywords !== null &&
    (keywords as Record<string, unknown>)['$mdnsent'] === true
  );
}

export const mdnMethods: Record<string, MethodHandler> = {
  'MDN/parse': async (rawArgs, ctx) => {
    const args = parseArguments(ParseArguments, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const blobIds = [...new Set(args.blobIds)];
    if (blobIds.length > ctx.limits.maxObjectsInGet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInGet} blobs may be parsed at once`,
      );
    }
    const parsed: Record<string, unknown> = {};
    const notParsable: string[] = [];
    const notFound: string[] = [];
    for (const blobId of blobIds) {
      const raw = IdSchema.safeParse(blobId).success
        ? await readBlob(ctx, blobId)
        : null;
      if (!raw) {
        notFound.push(blobId);
        continue;
      }
      const mdn = await parseMdn(ctx, raw);
      if (mdn) parsed[blobId] = mdn;
      else notParsable.push(blobId);
    }
    return {
      accountId,
      parsed: Object.keys(parsed).length > 0 ? parsed : null,
      notParsable: notParsable.length > 0 ? notParsable : null,
      notFound: notFound.length > 0 ? notFound : null,
    };
  },

  'MDN/send': async (rawArgs, ctx) => {
    const args = parseArguments(SendArguments, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const send = Object.entries(args.send);
    if (send.length > ctx.limits.maxObjectsInSet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInSet} notifications may be sent in one call`,
      );
    }
    const identityId = args.identityId;
    if (
      identityId === undefined ||
      !(await ctx.mail.identities()).some(
        (identity) => identity.id === identityId,
      )
    ) {
      throw new MethodError('invalidArguments', 'Unknown identity');
    }

    const sent: Record<string, Record<string, unknown>> = {};
    const notSent: Record<string, SetError> = {};
    const update: Record<string, Record<string, unknown>> = {};
    for (const [creationId, input] of send) {
      const patch = args.onSuccessUpdateEmail?.[`#${creationId}`];
      try {
        sent[creationId] = await sendMdn(
          ctx,
          input,
          identityId,
          setsMdnSent(patch),
        );
        update[input['forEmailId'] as string] = patch as Record<
          string,
          unknown
        >;
      } catch (error) {
        if (!(error instanceof SetFailure)) throw error;
        notSent[creationId] = error.error;
      }
    }

    if (Object.keys(update).length > 0) {
      ctx.extraResponses.push([
        'Email/set',
        { ...(await runEmailSet(ctx, { accountId, update })) },
      ]);
    }
    return {
      accountId,
      sent: Object.keys(sent).length > 0 ? sent : null,
      notSent: Object.keys(notSent).length > 0 ? notSent : null,
    };
  },
};
