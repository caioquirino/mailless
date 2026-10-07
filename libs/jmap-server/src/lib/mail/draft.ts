import { SetFailure, type EmailAddress } from '@mailless/jmap-core';
import {
  ComposeError,
  composeMessage,
  encodeText,
  formatAddresses,
  formatDate,
  formatMessageIds,
  type ComposeHeader,
  type ComposePart,
} from './compose.js';
import { parseHeaderProperty } from './headers.js';

/** What `Email/set` create produces before the message is stored. */
export interface Draft {
  raw: Uint8Array;
  mailboxIds: unknown;
  keywords: unknown;
  receivedAt: unknown;
}

const ADDRESS_HEADERS: Array<[property: string, header: string]> = [
  ['from', 'From'],
  ['sender', 'Sender'],
  ['replyTo', 'Reply-To'],
  ['to', 'To'],
  ['cc', 'Cc'],
  ['bcc', 'Bcc'],
];
const MESSAGE_ID_HEADERS: Array<[property: string, header: string]> = [
  ['inReplyTo', 'In-Reply-To'],
  ['references', 'References'],
];
const BODY_PROPERTIES = [
  'bodyStructure',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
];
const STORAGE_PROPERTIES = ['mailboxIds', 'keywords', 'receivedAt'];
const KNOWN_PROPERTIES = new Set([
  ...ADDRESS_HEADERS.map(([property]) => property),
  ...MESSAGE_ID_HEADERS.map(([property]) => property),
  'subject',
  'sentAt',
  'messageId',
  ...BODY_PROPERTIES,
  ...STORAGE_PROPERTIES,
]);
/** Headers the server writes itself, which a custom header may not duplicate or override. */
const RESERVED_HEADERS = new Set([
  ...ADDRESS_HEADERS.map(([, header]) => header.toLowerCase()),
  ...MESSAGE_ID_HEADERS.map(([, header]) => header.toLowerCase()),
  'subject',
  'date',
  'message-id',
  'mime-version',
]);

const MAX_PARTS = 100;
const MAX_DEPTH = 10;
const encoder = new TextEncoder();

function invalid(property: string, description: string): SetFailure {
  return new SetFailure('invalidProperties', description, {
    properties: [property],
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(input: Record<string, unknown>, property: string): boolean {
  return input[property] !== undefined && input[property] !== null;
}

function addressList(value: unknown, property: string): EmailAddress[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        isObject(item) &&
        typeof item['email'] === 'string' &&
        (item['name'] === undefined ||
          item['name'] === null ||
          typeof item['name'] === 'string'),
    )
  ) {
    throw invalid(
      property,
      `${property} must be a list of {name, email} objects`,
    );
  }
  return value.map((item) => ({
    name: (item['name'] as string | null | undefined) ?? null,
    email: item['email'] as string,
  }));
}

function stringList(value: unknown, property: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw invalid(property, `${property} must be a list of strings`);
  }
  return value as string[];
}

function buildHeaders(input: Record<string, unknown>): ComposeHeader[] {
  const headers: ComposeHeader[] = [];
  let fromDomain = 'mailless.invalid';

  for (const [property, header] of ADDRESS_HEADERS) {
    if (!present(input, property)) continue;
    const addresses = addressList(input[property], property);
    if (addresses.length === 0) continue;
    headers.push({ name: header, value: formatAddresses(addresses, property) });
    if (property === 'from') {
      fromDomain = (addresses[0] as EmailAddress).email
        .split('@')
        .pop() as string;
    }
  }

  if (present(input, 'subject')) {
    if (typeof input['subject'] !== 'string') {
      throw invalid('subject', 'subject must be a string');
    }
    headers.push({
      name: 'Subject',
      value: encodeText(input['subject'], 'subject'),
    });
  }

  let date = new Date();
  if (present(input, 'sentAt')) {
    date = new Date(input['sentAt'] as string);
    if (typeof input['sentAt'] !== 'string' || Number.isNaN(date.getTime())) {
      throw invalid('sentAt', 'sentAt must be a date');
    }
  }
  headers.push({ name: 'Date', value: formatDate(date) });

  let messageIds = [`${crypto.randomUUID()}@${fromDomain}`];
  if (present(input, 'messageId')) {
    messageIds = stringList(input['messageId'], 'messageId');
    if (messageIds.length !== 1) {
      throw invalid('messageId', 'messageId must contain exactly one id');
    }
  }
  headers.push({
    name: 'Message-ID',
    value: formatMessageIds(messageIds, 'messageId'),
  });

  for (const [property, header] of MESSAGE_ID_HEADERS) {
    if (!present(input, property)) continue;
    const ids = stringList(input[property], property);
    if (ids.length > 0) {
      headers.push({ name: header, value: formatMessageIds(ids, property) });
    }
  }

  for (const [property, value] of Object.entries(input)) {
    if (!property.startsWith('header:') || value === null) continue;
    let header;
    try {
      header = parseHeaderProperty(property);
    } catch {
      throw invalid(property, `"${property}" is not a valid header property`);
    }
    if (
      !header ||
      header.all ||
      (header.form !== 'asRaw' && header.form !== 'asText') ||
      typeof value !== 'string'
    ) {
      throw invalid(
        property,
        'Custom headers must be single strings in raw or text form',
      );
    }
    const lower = header.name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith('content-')) {
      throw invalid(property, `The ${header.name} header is set by the server`);
    }
    headers.push({
      name: header.name,
      value:
        header.form === 'asText' ? encodeText(value, property) : value.trim(),
    });
  }

  return headers;
}

interface BodyContext {
  bodyValues: Record<string, unknown>;
  readBlob(blobId: string): Promise<Uint8Array | null>;
  missingBlobs: string[];
  partCount: number;
}

async function buildPart(
  value: unknown,
  property: string,
  ctx: BodyContext,
  depth: number,
  defaultType?: string,
): Promise<ComposePart> {
  if (!isObject(value))
    throw invalid(property, 'Each body part must be an object');
  if (depth > MAX_DEPTH || ++ctx.partCount > MAX_PARTS) {
    throw invalid(property, 'The body has too many parts');
  }
  if (Array.isArray(value['headers']) && value['headers'].length > 0) {
    throw invalid(property, 'Headers on body parts are not supported');
  }

  const type = value['type'] ?? defaultType;
  if (typeof type !== 'string')
    throw invalid(property, 'A body part needs a type');
  const optional = (key: string): string | null => {
    const field = value[key];
    if (field === undefined || field === null) return null;
    if (typeof field !== 'string')
      throw invalid(property, `${key} must be a string`);
    return field;
  };
  const part: ComposePart = {
    type,
    name: optional('name'),
    disposition: optional('disposition'),
    cid: optional('cid'),
  };

  const hasPartId = value['partId'] !== undefined && value['partId'] !== null;
  const hasBlobId = value['blobId'] !== undefined && value['blobId'] !== null;
  const subParts = value['subParts'];

  if (Array.isArray(subParts)) {
    if (hasPartId || hasBlobId) {
      throw invalid(
        property,
        'A multipart part cannot have content of its own',
      );
    }
    part.subParts = [];
    for (const child of subParts) {
      part.subParts.push(await buildPart(child, property, ctx, depth + 1));
    }
    return part;
  }

  if (hasPartId === hasBlobId) {
    throw invalid(
      property,
      'A body part needs exactly one of partId and blobId',
    );
  }

  if (hasPartId) {
    const bodyValue = ctx.bodyValues[String(value['partId'])];
    if (!isObject(bodyValue) || typeof bodyValue['value'] !== 'string') {
      throw invalid(
        'bodyValues',
        `There is no body value for part "${String(value['partId'])}"`,
      );
    }
    if (
      bodyValue['isTruncated'] === true ||
      bodyValue['isEncodingProblem'] === true
    ) {
      throw invalid(
        'bodyValues',
        'Truncated or damaged body values cannot be stored',
      );
    }
    if (!type.toLowerCase().startsWith('text/')) {
      throw invalid(
        property,
        'Only text parts can take their content from bodyValues',
      );
    }
    part.charset = 'utf-8';
    part.content = encoder.encode(bodyValue['value'].replace(/\r?\n/g, '\r\n'));
    return part;
  }

  const blobId = String(value['blobId']);
  const content = await ctx.readBlob(blobId);
  if (!content) ctx.missingBlobs.push(blobId);
  else part.content = content;
  part.charset = optional('charset');
  return part;
}

async function buildBody(
  input: Record<string, unknown>,
  readBlob: BodyContext['readBlob'],
): Promise<ComposePart> {
  const bodyValues = input['bodyValues'] ?? {};
  if (!isObject(bodyValues))
    throw invalid('bodyValues', 'bodyValues must be an object');
  const ctx: BodyContext = {
    bodyValues,
    readBlob,
    missingBlobs: [],
    partCount: 0,
  };

  const flat = ['textBody', 'htmlBody', 'attachments'].filter((property) =>
    present(input, property),
  );
  let body: ComposePart;

  if (present(input, 'bodyStructure')) {
    if (flat.length > 0) {
      throw invalid(
        'bodyStructure',
        'Give either bodyStructure or textBody/htmlBody/attachments, not both',
      );
    }
    body = await buildPart(input['bodyStructure'], 'bodyStructure', ctx, 0);
  } else {
    const list = (property: string): unknown[] => {
      const value = input[property] ?? [];
      if (!Array.isArray(value))
        throw invalid(property, `${property} must be a list`);
      return value;
    };
    const single = async (property: string, type: string) => {
      const parts = list(property);
      if (parts.length > 1) {
        throw invalid(property, `${property} may contain at most one part`);
      }
      if (parts.length === 0) return undefined;
      const part = await buildPart(parts[0], property, ctx, 1, type);
      if (part.type.toLowerCase() !== type) {
        throw invalid(property, `The part in ${property} must be ${type}`);
      }
      return part;
    };

    const text = await single('textBody', 'text/plain');
    const html = await single('htmlBody', 'text/html');
    const attachments: ComposePart[] = [];
    for (const attachment of list('attachments')) {
      const part = await buildPart(attachment, 'attachments', ctx, 1);
      attachments.push({
        ...part,
        disposition: part.disposition ?? 'attachment',
      });
    }

    const main =
      text && html
        ? { type: 'multipart/alternative', subParts: [text, html] }
        : (text ?? html ?? { type: 'text/plain', charset: 'utf-8' });
    body =
      attachments.length > 0
        ? { type: 'multipart/mixed', subParts: [main, ...attachments] }
        : main;
  }

  if (ctx.missingBlobs.length > 0) {
    throw new SetFailure('blobNotFound', undefined, {
      notFound: [...new Set(ctx.missingBlobs)],
    });
  }
  return body;
}

/**
 * Turns the object given to `Email/set` create (RFC 8621 §4.6) into an
 * RFC 5322 message. Storage properties are passed through for the caller to
 * validate when it stores the result.
 */
export async function buildDraft(
  input: Record<string, unknown>,
  readBlob: (blobId: string) => Promise<Uint8Array | null>,
): Promise<Draft> {
  const unknown = Object.keys(input).filter(
    (property) =>
      !KNOWN_PROPERTIES.has(property) && !property.startsWith('header:'),
  );
  if (unknown.length > 0) {
    throw new SetFailure(
      'invalidProperties',
      'These properties cannot be set when creating an email',
      { properties: unknown },
    );
  }

  try {
    const headers = buildHeaders(input);
    const body = await buildBody(input, readBlob);
    return {
      raw: composeMessage(headers, body),
      mailboxIds: input['mailboxIds'],
      keywords: input['keywords'] ?? {},
      receivedAt: input['receivedAt'],
    };
  } catch (error) {
    if (error instanceof ComposeError) {
      throw new SetFailure('invalidProperties', error.message, {
        ...(error.property ? { properties: [error.property] } : {}),
      });
    }
    throw error;
  }
}
