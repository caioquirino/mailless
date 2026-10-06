import type { EmailAddress, EmailHeader } from '@mailless/jmap-core';
import PostalMime, { type Address } from 'postal-mime';
import { toUtcDate } from '../context.js';
import type { StoredBodyPart } from './model.js';

export interface ParsedPart {
  partId: string;
  type: string;
  charset: string | null;
  name: string | null;
  disposition: string | null;
  cid: string | null;
  data: Uint8Array;
}

export interface ParsedMetadata {
  headers: EmailHeader[];
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: EmailAddress[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
}

export interface ParsedMessage {
  metadata: ParsedMetadata;
  /** Leaf parts in order: text body, HTML body, then attachments. */
  parts: ParsedPart[];
  textPartId: string | null;
  htmlPartId: string | null;
  attachmentPartIds: string[];
}

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

const PREVIEW_LENGTH = 256;
const encoder = new TextEncoder();

export function parseMessageIds(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const ids = [...value.matchAll(/<([^<>]+)>/g)].map((match) =>
    (match[1] as string).trim(),
  );
  if (ids.length > 0) return ids;
  const bare = value.trim();
  return bare ? [bare] : null;
}

export function toEmailAddresses(
  addresses: Address | Address[] | undefined,
): EmailAddress[] | null {
  if (addresses === undefined) return null;
  const result: EmailAddress[] = [];
  for (const address of Array.isArray(addresses) ? addresses : [addresses]) {
    if (address.group) {
      for (const member of address.group) {
        result.push({ name: member.name || null, email: member.address });
      }
    } else if (address.address) {
      result.push({ name: address.name || null, email: address.address });
    }
  }
  return result;
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return encoder.encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
}

function makePreview(
  text: string | undefined,
  html: string | undefined,
): string {
  const source = text ?? (html === undefined ? '' : htmlToText(html));
  const collapsed = source.replace(/\s+/g, ' ').trim();
  return [...collapsed].slice(0, PREVIEW_LENGTH).join('');
}

function toSentAt(date: string | undefined): string | null {
  if (date === undefined) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : toUtcDate(parsed);
}

/**
 * Parses an RFC 5322 message into the metadata JMAP exposes.
 * The MIME tree is normalised to text body, HTML body and attachments rather
 * than preserved part for part.
 */
export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  let email;
  try {
    email = await PostalMime.parse(raw, {
      attachmentEncoding: 'arraybuffer',
      forceRfc822Attachments: true,
    });
  } catch (error) {
    throw new InvalidMessageError(
      error instanceof Error
        ? error.message
        : 'The message could not be parsed',
    );
  }

  const headers: EmailHeader[] = [];
  for (const { line } of email.headerLines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push({
      name: line.slice(0, colon),
      value: line.slice(colon + 1).replace(/\r?\n/g, '\r\n'),
    });
  }
  if (headers.length === 0) {
    throw new InvalidMessageError('The message has no header fields');
  }

  const parts: ParsedPart[] = [];
  const addPart = (part: Omit<ParsedPart, 'partId'>): string => {
    const partId = String(parts.length + 1);
    parts.push({ partId, ...part });
    return partId;
  };

  const textPartId =
    email.text === undefined
      ? null
      : addPart({
          type: 'text/plain',
          charset: 'utf-8',
          name: null,
          disposition: null,
          cid: null,
          data: encoder.encode(email.text),
        });
  const htmlPartId =
    email.html === undefined
      ? null
      : addPart({
          type: 'text/html',
          charset: 'utf-8',
          name: null,
          disposition: null,
          cid: null,
          data: encoder.encode(email.html),
        });
  const attachmentPartIds = email.attachments.map((attachment) =>
    addPart({
      type: attachment.mimeType.toLowerCase(),
      charset: null,
      name: attachment.filename,
      disposition: attachment.disposition,
      cid: attachment.contentId?.replace(/^<|>$/g, '') ?? null,
      data: toBytes(attachment.content),
    }),
  );

  return {
    metadata: {
      headers,
      messageId: parseMessageIds(email.messageId),
      inReplyTo: parseMessageIds(email.inReplyTo),
      references: parseMessageIds(email.references),
      sender: toEmailAddresses(email.sender),
      from: toEmailAddresses(email.from),
      to: toEmailAddresses(email.to),
      cc: toEmailAddresses(email.cc),
      bcc: toEmailAddresses(email.bcc),
      replyTo: toEmailAddresses(email.replyTo),
      subject: email.subject ?? null,
      sentAt: toSentAt(email.date),
      hasAttachment: email.attachments.some(
        (attachment) =>
          !attachment.related &&
          !(attachment.disposition === 'inline' && attachment.contentId),
      ),
      preview: makePreview(email.text, email.html),
    },
    parts,
    textPartId,
    htmlPartId,
    attachmentPartIds,
  };
}

/** The blob id under which one decoded body part of a stored message can be downloaded. */
export function partBlobId(messageBlobId: string, partId: string): string {
  return `${messageBlobId}-${partId}`;
}

export function splitPartBlobId(
  blobId: string,
): { messageBlobId: string; partId: string } | null {
  const match = /^(.+)-(\d+)$/.exec(blobId);
  return match
    ? { messageBlobId: match[1] as string, partId: match[2] as string }
    : null;
}

function multipart(type: string, subParts: StoredBodyPart[]): StoredBodyPart {
  return {
    partId: null,
    blobId: null,
    size: 0,
    name: null,
    type,
    charset: null,
    disposition: null,
    cid: null,
    subParts,
  };
}

export interface BodyLayout {
  bodyStructure: StoredBodyPart;
  textBody: string[];
  htmlBody: string[];
  attachments: string[];
}

export function buildBodyLayout(
  parsed: ParsedMessage,
  messageBlobId: string,
): BodyLayout {
  const leaves = new Map<string, StoredBodyPart>(
    parsed.parts.map((part) => [
      part.partId,
      {
        partId: part.partId,
        blobId: partBlobId(messageBlobId, part.partId),
        size: part.data.length,
        name: part.name,
        type: part.type,
        charset: part.charset,
        disposition: part.disposition,
        cid: part.cid,
        subParts: null,
      },
    ]),
  );
  const leaf = (partId: string | null): StoredBodyPart | null =>
    partId === null ? null : (leaves.get(partId) ?? null);

  const text = leaf(parsed.textPartId);
  const html = leaf(parsed.htmlPartId);
  const attachments = parsed.attachmentPartIds.map(
    (partId) => leaf(partId) as StoredBodyPart,
  );

  const body =
    text && html
      ? multipart('multipart/alternative', [text, html])
      : (text ?? html);

  let bodyStructure: StoredBodyPart;
  if (attachments.length > 0) {
    bodyStructure = multipart('multipart/mixed', [
      ...(body ? [body] : []),
      ...attachments,
    ]);
  } else {
    bodyStructure = body ?? {
      partId: '1',
      blobId: null,
      size: 0,
      name: null,
      type: 'text/plain',
      charset: 'utf-8',
      disposition: null,
      cid: null,
      subParts: null,
    };
  }

  const bodyIds = (preferred: string | null, fallback: string | null) =>
    preferred !== null ? [preferred] : fallback !== null ? [fallback] : [];

  return {
    bodyStructure,
    textBody: bodyIds(parsed.textPartId, parsed.htmlPartId),
    htmlBody: bodyIds(parsed.htmlPartId, parsed.textPartId),
    attachments: parsed.attachmentPartIds,
  };
}
