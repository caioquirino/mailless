import type { EmailAddress, EmailHeader } from '@mailless/jmap-core';
import { addressParser, decodeWords } from 'postal-mime';
import type { StoredBodyPart } from './model.js';

/*
 * Reads an RFC 5322 message into the structure JMAP describes (RFC 8621
 * §4.1.4): the tree of MIME parts as it is in the message, each part with its
 * own headers, and the three flat lists (text body, HTML body, attachments)
 * that the RFC derives from the tree.
 */

/** A part of a message: a leaf holding content, or a multipart holding parts. */
export interface ParsedPart {
  /** Numbers the leaves in the order they appear; null for a multipart. */
  partId: string | null;
  headers: EmailHeader[];
  /** Lower case, without parameters. */
  type: string;
  /** As declared; for text without a declared charset, `us-ascii`. Null for anything that is not text. */
  charset: string | null;
  name: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  /** The content after undoing the transfer encoding. Empty for a multipart. */
  data: Uint8Array;
  subParts: ParsedPart[] | null;
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
  /** The message's own part: the root of the tree. */
  structure: ParsedPart;
  /** Every leaf, in order. */
  parts: ParsedPart[];
  /** Part ids, as RFC 8621 §4.1.4 selects them. */
  textBody: string[];
  htmlBody: string[];
  attachments: string[];
}

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

const PREVIEW_LENGTH = 256;
const MAX_DEPTH = 32;
const MAX_PARTS = 1000;
/** Bytes map one to one onto characters, so positions in this view are positions in the message. */
const byteView = new TextDecoder('latin1');
const utf8 = new TextDecoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export function parseMessageIds(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const ids = [...value.matchAll(/<([^<>]+)>/g)].map((match) =>
    (match[1] as string).trim(),
  );
  if (ids.length > 0) return ids;
  const bare = value.trim();
  return bare ? [bare] : null;
}

function unfold(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, '');
}

function lastHeader(
  headers: readonly EmailHeader[],
  name: string,
): string | undefined {
  for (let index = headers.length - 1; index >= 0; index--) {
    const header = headers[index] as EmailHeader;
    if (header.name.toLowerCase() === name) return header.value;
  }
  return undefined;
}

/** Every address of a header that may list several, with groups flattened. */
function allAddresses(
  headers: readonly EmailHeader[],
  name: string,
): EmailAddress[] | null {
  const value = lastHeader(headers, name);
  if (value === undefined) return null;
  return addressParser(unfold(value), { flatten: true }).flatMap((address) =>
    address.address
      ? [{ name: decodeWords(address.name) || null, email: address.address }]
      : [],
  );
}

// The named character references of HTML 4 for U+00A0 to U+00FF, in code point order.
const LATIN1_ENTITIES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

const NAMED_ENTITIES = new Map<string, string>([
  ...LATIN1_ENTITIES.split(' ').map((name, index): [string, string] => [
    name,
    String.fromCharCode(160 + index),
  ]),
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['ndash', '\u2013'],
  ['mdash', '\u2014'],
  ['lsquo', '\u2018'],
  ['rsquo', '\u2019'],
  ['ldquo', '\u201c'],
  ['rdquo', '\u201d'],
  ['bull', '\u2022'],
  ['hellip', '\u2026'],
  ['euro', '\u20ac'],
  ['trade', '\u2122'],
]);

/** The text a reader would see: markup, styles and scripts removed, character references decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi,
      (entity, dec, hex, name) => {
        if (name !== undefined) {
          return NAMED_ENTITIES.get(name as string) ?? entity;
        }
        const code =
          dec !== undefined ? Number(dec) : parseInt(hex as string, 16);
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : ' ';
      },
    );
}

// ------------------------------------------------------------------ headers

/** Header bytes are ASCII by the standard; in practice some are UTF-8 and a few are Latin-1. */
function decodeHeaderBytes(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return byteView.decode(bytes);
  }
}

interface Section {
  headers: EmailHeader[];
  /** Where the content starts, after the empty line that ends the headers. */
  bodyStart: number;
}

/** Reads the header fields that start at `start`, up to the first empty line. */
function readHeaders(
  raw: Uint8Array,
  view: string,
  start: number,
  end: number,
): Section {
  const lines: string[] = [];
  let position = start;
  let bodyStart = end;
  while (position < end) {
    let lineEnd = view.indexOf('\n', position);
    if (lineEnd === -1 || lineEnd >= end) lineEnd = end;
    const contentEnd =
      lineEnd > position && view[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const next = Math.min(lineEnd + 1, end);
    if (contentEnd === position) {
      bodyStart = next;
      break;
    }
    const line = decodeHeaderBytes(raw.subarray(position, contentEnd));
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += `\r\n${line}`;
    } else {
      lines.push(line);
    }
    position = next;
    bodyStart = next;
  }

  const headers: EmailHeader[] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    // A line that is not a header field is skipped, as mail software generally does.
    if (colon <= 0 || /[\s]/.test(line.slice(0, colon).trimEnd())) continue;
    headers.push({
      name: line.slice(0, colon).trimEnd(),
      value: line.slice(colon + 1),
    });
  }
  return { headers, bodyStart };
}

interface Parameterised {
  value: string;
  parameters: Map<string, string>;
}

function percentDecode(text: string, charset: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const hex = text[index] === '%' ? text.slice(index + 1, index + 3) : '';
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index) & 0xff);
    }
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(Uint8Array.from(bytes));
  } catch {
    return utf8.decode(Uint8Array.from(bytes));
  }
}

/**
 * Splits a header such as Content-Type into its value and parameters,
 * including parameters continued or character-encoded as in RFC 2231.
 */
function parseParameterised(header: string | undefined): Parameterised {
  const text = unfold(header ?? '');
  const semicolon = text.indexOf(';');
  const value = (semicolon === -1 ? text : text.slice(0, semicolon))
    .trim()
    .toLowerCase();
  const parameters = new Map<string, string>();
  if (semicolon === -1) return { value, parameters };

  const simple = new Map<string, string>();
  const sections = new Map<
    string,
    Array<{ index: number; text: string; encoded: boolean }>
  >();
  const pattern = /;\s*([^\s=;"]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (const match of text.slice(semicolon).matchAll(pattern)) {
    const name = (match[1] as string).toLowerCase();
    const content =
      match[2] !== undefined
        ? match[2].replace(/\\(.)/g, '$1')
        : (match[3] as string).trim();
    const extended = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(name);
    if (!extended || (extended[2] === undefined && !extended[3])) {
      if (!simple.has(name)) simple.set(name, decodeWords(content));
      continue;
    }
    const base = extended[1] as string;
    const list = sections.get(base) ?? [];
    list.push({
      index: Number(extended[2] ?? 0),
      text: content,
      encoded: extended[3] !== undefined,
    });
    sections.set(base, list);
  }

  for (const [name, list] of sections) {
    list.sort((a, b) => a.index - b.index);
    let charset = 'utf-8';
    let result = '';
    list.forEach((section, position) => {
      let content = section.text;
      if (section.encoded && position === 0) {
        // charset'language'value
        const parts = /^([^']*)'[^']*'(.*)$/.exec(content);
        if (parts) {
          charset = parts[1] || 'utf-8';
          content = parts[2] as string;
        }
      }
      result += section.encoded ? percentDecode(content, charset) : content;
    });
    parameters.set(name, result);
  }
  // The RFC 2231 form wins over a plain parameter of the same name.
  for (const [name, content] of simple) {
    if (!parameters.has(name)) parameters.set(name, content);
  }
  return { value, parameters };
}

// ------------------------------------------------------------------ content

function decodeBase64(view: string, start: number, end: number): Uint8Array {
  const clean = view.slice(start, end).replace(/[^A-Za-z0-9+/]/g, '');
  const usable = clean.length - (clean.length % 4 === 1 ? 1 : 0);
  const output = new Uint8Array(Math.floor((usable * 3) / 4));
  let written = 0;
  // In pieces, so that a large attachment does not need one huge intermediate string.
  const CHUNK = 1 << 20;
  for (let offset = 0; offset < usable; offset += CHUNK) {
    const binary = atob(clean.slice(offset, Math.min(offset + CHUNK, usable)));
    for (let index = 0; index < binary.length; index++) {
      output[written++] = binary.charCodeAt(index);
    }
  }
  return output.subarray(0, written);
}

function decodeQuotedPrintable(
  raw: Uint8Array,
  start: number,
  end: number,
): Uint8Array {
  const output = new Uint8Array(end - start);
  let written = 0;
  const hex = (code: number | undefined): number => {
    if (code === undefined) return -1;
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    const lower = code | 0x20;
    return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
  };
  for (let index = start; index < end; index++) {
    const byte = raw[index] as number;
    if (byte !== 0x3d) {
      output[written++] = byte;
      continue;
    }
    // "=" at the end of a line joins it to the next one.
    let after = index + 1;
    while (after < end && (raw[after] === 0x20 || raw[after] === 0x09)) after++;
    if (after >= end) break;
    if (raw[after] === 0x0a) {
      index = after;
      continue;
    }
    if (raw[after] === 0x0d && raw[after + 1] === 0x0a) {
      index = after + 1;
      continue;
    }
    const high = hex(raw[index + 1]);
    const low = index + 2 < end ? hex(raw[index + 2]) : -1;
    if (high >= 0 && low >= 0) {
      output[written++] = high * 16 + low;
      index += 2;
    } else {
      output[written++] = byte;
    }
  }
  return output.subarray(0, written);
}

// --------------------------------------------------------------------- tree

interface Reading {
  raw: Uint8Array;
  view: string;
  parts: ParsedPart[];
  count: number;
}

/** The positions of the delimiter lines of a multipart, and whether each one closes it. */
function findDelimiters(
  view: string,
  boundary: string,
  start: number,
  end: number,
): Array<{ lineStart: number; contentStart: number; closing: boolean }> {
  const marker = `--${boundary}`;
  const found: Array<{
    lineStart: number;
    contentStart: number;
    closing: boolean;
  }> = [];
  let from = start;
  while (from < end) {
    const at = view.indexOf(marker, from);
    if (at === -1 || at >= end) break;
    from = at + marker.length;
    if (at !== start && view[at - 1] !== '\n') continue;

    let lineEnd = view.indexOf('\n', from);
    if (lineEnd === -1 || lineEnd > end) lineEnd = end;
    const rest = view.slice(from, lineEnd).replace(/\r$/, '');
    const closing = rest.startsWith('--');
    // Anything but trailing white space means this line only looks like a delimiter.
    if (!/^[ \t]*$/.test(closing ? rest.slice(2) : rest)) continue;

    found.push({
      lineStart: at,
      contentStart: Math.min(lineEnd + 1, end),
      closing,
    });
    from = lineEnd;
    if (closing) break;
  }
  return found;
}

function readPart(
  reading: Reading,
  start: number,
  end: number,
  defaultType: string,
  depth: number,
): ParsedPart {
  const { raw, view } = reading;
  const { headers, bodyStart } = readHeaders(raw, view, start, end);
  const contentType = parseParameterised(lastHeader(headers, 'content-type'));
  const disposition = parseParameterised(
    lastHeader(headers, 'content-disposition'),
  );
  const hasType = /^[^\s/]+\/[^\s/]+$/.test(contentType.value);
  let type = hasType ? contentType.value : defaultType;

  const cid = lastHeader(headers, 'content-id');
  const language = lastHeader(headers, 'content-language');
  const location = lastHeader(headers, 'content-location');
  const part: ParsedPart = {
    partId: null,
    headers,
    type,
    charset: null,
    name:
      disposition.parameters.get('filename') ??
      contentType.parameters.get('name') ??
      null,
    disposition: disposition.value || null,
    cid:
      cid === undefined
        ? null
        : unfold(cid).trim().replace(/^<|>$/g, '') || null,
    language:
      language === undefined
        ? null
        : unfold(language)
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
    location: location === undefined ? null : unfold(location).trim() || null,
    data: new Uint8Array(),
    subParts: null,
  };

  const boundary = contentType.parameters.get('boundary');
  if (
    type.startsWith('multipart/') &&
    boundary &&
    depth < MAX_DEPTH &&
    reading.count < MAX_PARTS
  ) {
    const delimiters = findDelimiters(view, boundary, bodyStart, end);
    if (delimiters.length > 0) {
      const childType =
        type === 'multipart/digest' ? 'message/rfc822' : 'text/plain';
      part.subParts = [];
      for (let index = 0; index < delimiters.length; index++) {
        const current = delimiters[index] as (typeof delimiters)[number];
        if (current.closing) break;
        const next = delimiters[index + 1];
        // The line break before a delimiter belongs to the delimiter, not to the part.
        let childEnd = next ? next.lineStart : end;
        if (next && view[childEnd - 1] === '\n') childEnd -= 1;
        if (next && view[childEnd - 1] === '\r') childEnd -= 1;
        reading.count += 1;
        part.subParts.push(
          readPart(
            reading,
            current.contentStart,
            Math.max(childEnd, current.contentStart),
            childType,
            depth + 1,
          ),
        );
      }
      return part;
    }
  }
  // A multipart that cannot be taken apart is shown as the text it is.
  if (type.startsWith('multipart/')) type = part.type = 'text/plain';

  const encoding = unfold(
    lastHeader(headers, 'content-transfer-encoding') ?? '',
  )
    .trim()
    .toLowerCase();
  part.data =
    encoding === 'base64'
      ? decodeBase64(view, bodyStart, end)
      : encoding === 'quoted-printable'
        ? decodeQuotedPrintable(raw, bodyStart, end)
        : raw.subarray(bodyStart, end);
  if (type.startsWith('text/')) {
    part.charset = contentType.parameters.get('charset') ?? 'us-ascii';
  } else if (!hasType) {
    part.charset = 'us-ascii';
  }
  reading.parts.push(part);
  part.partId = String(reading.parts.length);
  return part;
}

/** The text of a part, by its declared charset, with line ends as single line feeds. */
export function partText(part: ParsedPart): {
  value: string;
  isEncodingProblem: boolean;
} {
  let value: string;
  let isEncodingProblem = false;
  try {
    value = new TextDecoder(part.charset ?? 'utf-8', { fatal: true }).decode(
      part.data,
    );
  } catch {
    // An unknown charset, or bytes that are not valid in it: show what can be shown.
    isEncodingProblem = true;
    value = utf8.decode(part.data);
  }
  return { value: value.replace(/\r\n/g, '\n'), isEncodingProblem };
}

function isInlineMediaType(type: string): boolean {
  return (
    type.startsWith('image/') ||
    type.startsWith('audio/') ||
    type.startsWith('video/')
  );
}

/**
 * Sorts the leaves of the tree into what to show as the body and what to
 * offer as attachments. This is the algorithm RFC 8621 §4.1.4 gives, kept in
 * its shape so the two can be compared.
 */
function parseStructure(
  parts: ParsedPart[],
  multipartType: string,
  inAlternative: boolean,
  htmlBody: ParsedPart[] | null,
  textBody: ParsedPart[] | null,
  attachments: ParsedPart[],
): void {
  const textLength = textBody ? textBody.length : -1;
  const htmlLength = htmlBody ? htmlBody.length : -1;

  parts.forEach((part, index) => {
    const isInline =
      part.disposition !== 'attachment' &&
      (part.type === 'text/plain' ||
        part.type === 'text/html' ||
        isInlineMediaType(part.type)) &&
      (index === 0 ||
        (multipartType !== 'related' &&
          (isInlineMediaType(part.type) || !part.name)));

    if (part.subParts) {
      const subMultiType = part.type.split('/')[1] as string;
      parseStructure(
        part.subParts,
        subMultiType,
        inAlternative || subMultiType === 'alternative',
        htmlBody,
        textBody,
        attachments,
      );
    } else if (isInline) {
      if (multipartType === 'alternative') {
        if (part.type === 'text/plain') textBody?.push(part);
        else if (part.type === 'text/html') htmlBody?.push(part);
        else attachments.push(part);
        return;
      }
      if (inAlternative) {
        if (part.type === 'text/plain') htmlBody = null;
        if (part.type === 'text/html') textBody = null;
      }
      textBody?.push(part);
      htmlBody?.push(part);
      if ((!htmlBody || !textBody) && isInlineMediaType(part.type)) {
        attachments.push(part);
      }
    } else {
      attachments.push(part);
    }
  });

  if (multipartType === 'alternative' && textBody && htmlBody) {
    // Only an HTML part was found: it is the text body too.
    if (textLength === textBody.length && htmlLength !== htmlBody.length) {
      textBody.push(...htmlBody.slice(htmlLength));
    }
    // Only a plain text part was found: it is the HTML body too.
    if (htmlLength === htmlBody.length && textLength !== textBody.length) {
      htmlBody.push(...textBody.slice(textLength));
    }
  }
}

function makePreview(parsed: {
  parts: ParsedPart[];
  textBody: string[];
  htmlBody: string[];
}): string {
  const byId = new Map(parsed.parts.map((part) => [part.partId, part]));
  const firstText = (ids: readonly string[], type: string) =>
    ids.map((id) => byId.get(id)).find((part) => part?.type === type);
  const plain = firstText(parsed.textBody, 'text/plain');
  const html = plain ? undefined : firstText(parsed.htmlBody, 'text/html');
  const source = plain
    ? partText(plain).value
    : html
      ? htmlToText(partText(html).value)
      : '';
  const collapsed = source.replace(/\s+/g, ' ').trim();
  return [...collapsed].slice(0, PREVIEW_LENGTH).join('');
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
/** The named zones of RFC 5322 §4.3, in minutes from UTC. Any other name means "unknown", read as UTC. */
const NAMED_ZONES: Record<string, number> = {
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
};
const MAIL_DATE =
  /^(?:[a-z]{3}\s*,\s*)?(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[a-z]+)?$/i;

/**
 * Reads the date of a header such as Date into the form JMAP uses, keeping
 * the time zone offset it was written with. Null when it is not a date.
 */
export function parseMailDate(value: string): string | null {
  // Comments in parentheses, such as "(CET)", are not part of the date.
  const text = unfold(value)
    .replace(/\([^()]*\)/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const match = MAIL_DATE.exec(text);
  if (!match) return null;
  const [, day, monthName, yearText, hour, minute, second = '0', zone = ''] =
    match as unknown as string[];
  const month = MONTHS.indexOf((monthName as string).toLowerCase());
  if (month === -1) return null;
  let year = Number(yearText);
  // Two-digit years, as old software wrote them.
  if ((yearText as string).length <= 2) year += year < 50 ? 2000 : 1900;
  else if ((yearText as string).length === 3) year += 1900;

  let offset = 0;
  if (/^[+-]\d{4}$/.test(zone)) {
    const minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3));
    offset = zone.startsWith('-') ? -minutes : minutes;
  } else {
    offset = NAMED_ZONES[zone.toLowerCase()] ?? 0;
  }

  const local = Date.UTC(
    year,
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const check = new Date(local);
  if (
    Number.isNaN(local) ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 60 ||
    Math.abs(offset) >= 24 * 60
  ) {
    return null;
  }
  const stamp = check.toISOString().slice(0, 19);
  if (offset === 0) return `${stamp}Z`;
  const pad = (number: number) => String(number).padStart(2, '0');
  const absolute = Math.abs(offset);
  return `${stamp}${offset < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function toSentAt(date: string | undefined): string | null {
  return date === undefined ? null : parseMailDate(date);
}

/** Parses an RFC 5322 message into the metadata and structure JMAP exposes. */
export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const reading: Reading = {
    raw,
    view: byteView.decode(raw),
    parts: [],
    count: 1,
  };
  const structure = readPart(reading, 0, raw.length, 'text/plain', 0);
  const headers = structure.headers;
  if (headers.length === 0) {
    throw new InvalidMessageError('The message has no header fields');
  }

  const textBody: ParsedPart[] = [];
  const htmlBody: ParsedPart[] = [];
  const attachments: ParsedPart[] = [];
  parseStructure([structure], 'mixed', false, htmlBody, textBody, attachments);
  const ids = (parts: ParsedPart[]) =>
    parts.map((part) => part.partId as string);
  const lists = {
    parts: reading.parts,
    textBody: ids(textBody),
    htmlBody: ids(htmlBody),
    attachments: ids(attachments),
  };

  const subject = lastHeader(headers, 'subject');
  return {
    metadata: {
      headers,
      messageId: parseMessageIds(lastHeader(headers, 'message-id')),
      inReplyTo: parseMessageIds(lastHeader(headers, 'in-reply-to')),
      references: parseMessageIds(lastHeader(headers, 'references')),
      sender: allAddresses(headers, 'sender'),
      from: allAddresses(headers, 'from'),
      to: allAddresses(headers, 'to'),
      cc: allAddresses(headers, 'cc'),
      bcc: allAddresses(headers, 'bcc'),
      replyTo: allAddresses(headers, 'reply-to'),
      subject:
        subject === undefined
          ? null
          : decodeWords(unfold(subject)).trim().normalize('NFC'),
      sentAt: toSentAt(lastHeader(headers, 'date')),
      // What a mail app would offer for download: anything attached that is not shown in place.
      hasAttachment: attachments.some((part) => part.disposition !== 'inline'),
      preview: makePreview(lists),
    },
    structure,
    ...lists,
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

export interface BodyLayout {
  bodyStructure: StoredBodyPart;
  textBody: string[];
  htmlBody: string[];
  attachments: string[];
}

/** The structure of a parsed message in the form it is stored with the email. */
export function buildBodyLayout(
  parsed: ParsedMessage,
  messageBlobId: string,
): BodyLayout {
  const store = (part: ParsedPart, isRoot: boolean): StoredBodyPart => ({
    partId: part.partId,
    blobId:
      part.partId === null ? null : partBlobId(messageBlobId, part.partId),
    size: part.data.length,
    // The message's own headers are kept once, with the email.
    headers: isRoot ? [] : part.headers,
    name: part.name,
    type: part.type,
    charset: part.charset,
    disposition: part.disposition,
    cid: part.cid,
    language: part.language,
    location: part.location,
    subParts: part.subParts?.map((child) => store(child, false)) ?? null,
  });
  return {
    bodyStructure: store(parsed.structure, true),
    textBody: parsed.textBody,
    htmlBody: parsed.htmlBody,
    attachments: parsed.attachments,
  };
}

/**
 * The calendar objects a message carries (an invitation, an answer to one, a
 * cancellation: RFC 6047), as text, and who the message is from. Nothing is
 * parsed of a message that names no calendar anywhere.
 */
export async function calendarParts(
  raw: Uint8Array,
): Promise<{ from: string | null; calendars: string[] }> {
  const none = { from: null, calendars: [] };
  // Latin-1 keeps every byte a letter: enough to look for a word.
  if (
    !/text\/calendar|application\/ics/i.test(
      new TextDecoder('latin1').decode(raw),
    )
  ) {
    return none;
  }
  let parsed: ParsedMessage;
  try {
    parsed = await parseMessage(raw);
  } catch {
    return none;
  }
  return {
    from: parsed.metadata.from?.[0]?.email?.toLowerCase() ?? null,
    calendars: parsed.parts
      .filter(
        (part) =>
          part.type === 'text/calendar' || part.type === 'application/ics',
      )
      .map((part) => partText(part).value),
  };
}
