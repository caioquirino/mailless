import type { EmailAddress } from '@mailless/jmap-core';

/** A node of the MIME tree to build: a leaf with content, or a multipart with children. */
export interface ComposePart {
  type: string;
  charset?: string | null;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  language?: string[] | null;
  location?: string | null;
  /** Further parameters of a multipart's Content-Type, such as `report-type`. */
  parameters?: Record<string, string>;
  /** Further header fields of this part, after the ones made from the properties above. */
  headers?: ComposeHeader[];
  content?: Uint8Array;
  subParts?: ComposePart[];
}

export interface ComposeHeader {
  name: string;
  /** Already formatted for the wire, apart from folding. */
  value: string;
  /** Written exactly as given, without folding: the client supplied the raw form. */
  raw?: boolean;
}

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly property?: string,
  ) {
    super(message);
    this.name = 'ComposeError';
  }
}

const encoder = new TextEncoder();
const CRLF = '\r\n';
const MAX_LINE = 76;
const ADDRESS = /^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+$/;
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

function isAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}

function assertSingleLine(text: string, property?: string): void {
  // A line break inside a header value would let the caller add headers of their own.
  if (/[\r\n\0]/.test(text)) {
    throw new ComposeError(
      'Header values may not contain line breaks',
      property,
    );
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** RFC 2047 encoded-words, split so that no word exceeds 75 characters or cuts a character in half. */
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const character of text) {
    if (encoder.encode(chunk + character).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`)
    .join(' ');
}

/** Free text for an unstructured header such as Subject. */
export function encodeText(text: string, property?: string): string {
  assertSingleLine(text, property);
  return isAscii(text) ? text : encodedWords(text);
}

function encodePhrase(name: string, property?: string): string {
  assertSingleLine(name, property);
  if (!isAscii(name)) return encodedWords(name);
  // Always quoted: that is valid for any name, and needs no rule for which may go bare.
  return `"${name.replace(/(["\\])/g, '\\$1')}"`;
}

export function isValidAddress(email: string): boolean {
  return email.length <= 254 && ADDRESS.test(email);
}

export function formatAddresses(
  addresses: readonly EmailAddress[],
  property?: string,
): string {
  return addresses
    .map((address) => {
      if (typeof address.email !== 'string' || !isValidAddress(address.email)) {
        throw new ComposeError(
          `"${String(address.email)}" is not a valid email address`,
          property,
        );
      }
      return address.name
        ? `${encodePhrase(address.name, property)} <${address.email}>`
        : address.email;
    })
    .join(', ');
}

export function formatMessageIds(
  ids: readonly string[],
  property?: string,
): string {
  return ids
    .map((id) => {
      if (typeof id !== 'string' || !/^[^\s<>]+$/.test(id)) {
        throw new ComposeError(
          `"${String(id)}" is not a valid message id`,
          property,
        );
      }
      return `<${id}>`;
    })
    .join(' ');
}

export function formatDate(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

/**
 * A JMAP date, which may carry a time zone offset, as an RFC 5322 date with
 * the same offset. Null when the text is not such a date.
 */
export function formatDateWithOffset(text: string): string | null {
  const match =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/i.exec(
      text,
    );
  if (!match || Number.isNaN(Date.parse(text))) return null;
  const [, year, month, day, hour, minute, second, zone] =
    match as unknown as string[];
  // The date as the sender's clock showed it, to name the right day of the week.
  const local = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  const [weekday, , monthName] = local.toUTCString().split(/[ ,]+/) as [
    string,
    string,
    string,
  ];
  const offset =
    (zone as string).toUpperCase() === 'Z'
      ? '+0000'
      : (zone as string).replace(':', '');
  return `${weekday}, ${day} ${monthName} ${year} ${hour}:${minute}:${second} ${offset}`;
}

/** Groups of addresses, as in `Team: a@example.com, b@example.com;`. A group without a name is a plain list. */
export function formatGroupedAddresses(
  groups: ReadonlyArray<{ name: string | null; addresses: EmailAddress[] }>,
  property?: string,
): string {
  return groups
    .map((group) => {
      const list = formatAddresses(group.addresses, property);
      return group.name === null
        ? list
        : `${encodePhrase(group.name, property)}: ${list};`;
    })
    .filter(Boolean)
    .join(', ');
}

export function formatUrls(urls: readonly string[], property?: string): string {
  return urls
    .map((url) => {
      if (typeof url !== 'string' || !/^[^\s<>]+$/.test(url)) {
        throw new ComposeError(`"${String(url)}" is not a valid URL`, property);
      }
      return `<${url}>`;
    })
    .join(', ');
}

/** Breaks a header onto continuation lines at whitespace so that lines stay short. */
function fold(name: string, value: string): string {
  const words = `${name}: ${value}`.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > MAX_LINE) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

function parameter(name: string, value: string): string {
  if (isAscii(value)) {
    return TOKEN.test(value)
      ? `${name}=${value}`
      : `${name}="${value.replace(/(["\\])/g, '\\$1')}"`;
  }
  // RFC 2231: non-ASCII parameter values are percent-encoded UTF-8.
  const encoded = [...encoder.encode(value)]
    .map((byte) =>
      /[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
  return `${name}*=UTF-8''${encoded}`;
}

function wrap(text: string): string {
  return text.match(new RegExp(`.{1,${MAX_LINE}}`, 'g'))?.join(CRLF) ?? '';
}

function quotedPrintable(bytes: Uint8Array): string {
  const lines: string[] = [];
  let line = '';
  const push = (token: string) => {
    // Leave room for the "=" that marks a soft line break.
    if (line.length + token.length > MAX_LINE - 1) {
      lines.push(`${line}=`);
      line = '';
    }
    line += token;
  };

  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] as number;
    if (byte === 0x0d && bytes[index + 1] === 0x0a) {
      lines.push(line);
      line = '';
      index += 1;
      continue;
    }
    if (byte === 0x0a) {
      lines.push(line);
      line = '';
      continue;
    }
    const next = bytes[index + 1];
    const endsLine = next === undefined || next === 0x0a || next === 0x0d;
    const literal =
      (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d) ||
      // Whitespace is only safe when something follows it on the same line.
      ((byte === 0x20 || byte === 0x09) && !endsLine);
    push(
      literal
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    );
  }
  lines.push(line);
  return lines.join(CRLF);
}

function isPlainSevenBit(bytes: Uint8Array): boolean {
  let lineLength = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] as number;
    if (byte === 0x0d && bytes[index + 1] === 0x0a) {
      lineLength = 0;
      index += 1;
      continue;
    }
    // Bare CR or LF, control characters and long lines all need an encoding.
    if (byte > 0x7e || (byte < 0x20 && byte !== 0x09)) return false;
    if (++lineLength > MAX_LINE) return false;
  }
  return true;
}

function randomBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `=_mailless_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function renderHeader({ name, value, raw }: ComposeHeader): string {
  if (!HEADER_NAME.test(name)) {
    throw new ComposeError(`"${name}" is not a valid header name`);
  }
  if (!raw) {
    assertSingleLine(value);
    return fold(name, value);
  }
  // A raw value may be folded already; any other line break would start a new header.
  if (/\0|\r(?!\n)|(?<!\r)\n|\r\n(?![ \t])/.test(value)) {
    throw new ComposeError('Header values may not contain line breaks');
  }
  return `${name}:${/^[ \t]/.test(value) ? '' : ' '}${value}`;
}

/** The header fields that say what a part is, other than its type and disposition. */
function describingHeaders(part: ComposePart): string[] {
  const headers: string[] = [];
  if (part.cid) {
    assertSingleLine(part.cid);
    headers.push(fold('Content-ID', `<${part.cid.replace(/^<|>$/g, '')}>`));
  }
  if (part.language && part.language.length > 0) {
    for (const tag of part.language) {
      if (typeof tag !== 'string' || !/^[A-Za-z0-9-]+$/.test(tag)) {
        throw new ComposeError(`"${String(tag)}" is not a language tag`);
      }
    }
    headers.push(fold('Content-Language', part.language.join(', ')));
  }
  if (part.location) {
    assertSingleLine(part.location);
    headers.push(fold('Content-Location', part.location));
  }
  headers.push(...(part.headers ?? []).map(renderHeader));
  return headers;
}

function renderPart(part: ComposePart): string {
  const type = part.type.toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    throw new ComposeError(`"${part.type}" is not a valid media type`);
  }

  if (part.subParts) {
    if (!type.startsWith('multipart/')) {
      throw new ComposeError('Only multipart parts may have sub-parts');
    }
    const boundary = randomBoundary();
    const extra = Object.entries(part.parameters ?? {}).map(
      ([name, value]) => `; ${parameter(name, value)}`,
    );
    return [
      fold(
        'Content-Type',
        `${type}${extra.join('')}; ${parameter('boundary', boundary)}`,
      ),
      ...describingHeaders(part),
      '',
      ...part.subParts.flatMap((child) => [`--${boundary}`, renderPart(child)]),
      `--${boundary}--`,
    ].join(CRLF);
  }
  if (type.startsWith('multipart/')) {
    throw new ComposeError('A multipart part needs sub-parts');
  }

  const content = part.content ?? new Uint8Array();
  const isText = type.startsWith('text/');
  const contentType = [type];
  if (isText) contentType.push(parameter('charset', part.charset ?? 'utf-8'));
  // Without a disposition the name can only go here; with one, older software still looks here.
  if (part.name && (isAscii(part.name) || !part.disposition)) {
    contentType.push(parameter('name', part.name));
  }

  const headers = [fold('Content-Type', contentType.join('; '))];
  if (part.disposition) {
    const disposition = part.disposition.toLowerCase();
    if (!TOKEN.test(disposition)) {
      throw new ComposeError(
        `"${part.disposition}" is not a valid disposition`,
      );
    }
    headers.push(
      fold(
        'Content-Disposition',
        part.name
          ? `${disposition}; ${parameter('filename', part.name)}`
          : disposition,
      ),
    );
  }
  headers.push(...describingHeaders(part));

  let body: string;
  if (isText && isPlainSevenBit(content)) {
    headers.push('Content-Transfer-Encoding: 7bit');
    body = new TextDecoder().decode(content);
  } else if (isText) {
    headers.push('Content-Transfer-Encoding: quoted-printable');
    body = quotedPrintable(content);
  } else if (type.startsWith('message/') && isPlainSevenBit(content)) {
    // A message inside a message is carried as it is where it can be
    // (RFC 2046 §5.2.1), so that software reading the report can read it.
    headers.push('Content-Transfer-Encoding: 7bit');
    body = new TextDecoder().decode(content);
  } else {
    headers.push('Content-Transfer-Encoding: base64');
    body = wrap(base64(content));
  }
  return [...headers, '', body].join(CRLF);
}

/** Builds an RFC 5322 message from headers and a MIME tree. */
export function composeMessage(
  headers: readonly ComposeHeader[],
  body: ComposePart,
): Uint8Array {
  const lines = headers.map(renderHeader);
  // No line break is added after a body that is the whole message: it would
  // become part of the text. After a multipart's last delimiter it is customary.
  return encoder.encode(
    [...lines, 'MIME-Version: 1.0', renderPart(body)].join(CRLF) +
      (body.subParts ? CRLF : ''),
  );
}

/**
 * Removes every occurrence of a header field (with its continuation lines)
 * from a raw message. Used to keep Bcc recipients out of what is sent.
 */
export function removeHeader(raw: Uint8Array, name: string): Uint8Array {
  const text = new TextDecoder('latin1').decode(raw);
  const match = /\r?\n\r?\n/.exec(text);
  const headerEnd = match ? match.index + match[0].length : text.length;
  const lines = text.slice(0, headerEnd).split(/(?<=\n)/);

  const prefix = `${name.toLowerCase()}:`;
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const isContinuation = /^[ \t]/.test(line);
    if (!isContinuation) dropping = line.toLowerCase().startsWith(prefix);
    if (!dropping) kept.push(line);
  }

  const result = kept.join('') + text.slice(headerEnd);
  return Uint8Array.from(result, (character) => character.charCodeAt(0));
}
