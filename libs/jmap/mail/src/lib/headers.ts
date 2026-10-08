import {
  MethodError,
  type EmailAddress,
  type EmailAddressGroup,
  type EmailHeader,
} from '@mailless/jmap-core';
import { addressParser, decodeWords, type Address } from 'postal-mime';
import { parseMailDate, parseMessageIds } from './mime.js';

const FORMS = [
  'asRaw',
  'asText',
  'asAddresses',
  'asGroupedAddresses',
  'asMessageIds',
  'asDate',
  'asURLs',
] as const;
type HeaderForm = (typeof FORMS)[number];

/*
 * The parsed forms each known header field may be read or written in
 * (RFC 8621 §4.1.2). A field not listed is unknown to the standards and may
 * take any form; the raw form is always allowed.
 */
const FORMS_BY_FIELD = new Map<string, HeaderForm[]>();
for (const [fields, forms] of [
  [
    'from sender reply-to to cc bcc resent-from resent-sender resent-reply-to resent-to resent-cc resent-bcc',
    ['asAddresses', 'asGroupedAddresses'],
  ],
  ['message-id in-reply-to references resent-message-id', ['asMessageIds']],
  ['date resent-date', ['asDate']],
  [
    'list-help list-unsubscribe list-subscribe list-post list-owner list-archive',
    ['asURLs'],
  ],
  ['subject comments keywords list-id', ['asText']],
  ['return-path received', []],
] as Array<[string, HeaderForm[]]>) {
  for (const field of fields.split(' ')) FORMS_BY_FIELD.set(field, forms);
}

export function isFormAllowed(name: string, form: HeaderForm): boolean {
  const allowed = FORMS_BY_FIELD.get(name.toLowerCase());
  return form === 'asRaw' || !allowed || allowed.includes(form);
}

export interface HeaderProperty {
  name: string;
  form: HeaderForm;
  all: boolean;
}

/** Parses a `header:Name[:asForm][:all]` property name (RFC 8621 §4.1.3). */
export function parseHeaderProperty(property: string): HeaderProperty | null {
  if (!property.startsWith('header:')) return null;
  const [, name, ...rest] = property.split(':');
  const all = rest[rest.length - 1] === 'all';
  const formPart = all ? rest.slice(0, -1) : rest;
  const form = formPart[0] ?? 'asRaw';

  if (
    !name ||
    formPart.length > 1 ||
    !(FORMS as readonly string[]).includes(form)
  ) {
    throw new MethodError(
      'invalidArguments',
      `"${property}" is not a valid header property`,
    );
  }
  return { name, form: form as HeaderForm, all };
}

function unfold(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, '');
}

export function headerAsText(value: string): string {
  return decodeWords(unfold(value)).trim().normalize('NFC');
}

function toAddress(address: Address): EmailAddress[] {
  if (address.group) return address.group.flatMap(toAddress);
  return address.address
    ? [{ name: decodeWords(address.name) || null, email: address.address }]
    : [];
}

function asGroupedAddresses(value: string): EmailAddressGroup[] {
  const groups: EmailAddressGroup[] = [];
  let loose: EmailAddressGroup | undefined;
  for (const address of addressParser(unfold(value))) {
    if (address.group) {
      groups.push({
        name: decodeWords(address.name) || null,
        addresses: address.group.flatMap(toAddress),
      });
      loose = undefined;
      continue;
    }
    if (!loose) {
      loose = { name: null, addresses: [] };
      groups.push(loose);
    }
    loose.addresses.push(...toAddress(address));
  }
  return groups;
}

function convert(value: string, form: HeaderForm): unknown {
  switch (form) {
    case 'asRaw':
      return value;
    case 'asText':
      return headerAsText(value);
    case 'asAddresses':
      return addressParser(unfold(value), { flatten: true }).flatMap(toAddress);
    case 'asGroupedAddresses':
      return asGroupedAddresses(value);
    case 'asMessageIds':
      return parseMessageIds(unfold(value));
    case 'asDate':
      return parseMailDate(value);
    case 'asURLs': {
      const urls = [...unfold(value).matchAll(/<([^<>]+)>/g)].map(
        (match) => match[1] as string,
      );
      return urls.length > 0 ? urls : null;
    }
  }
}

export function headerValues(
  headers: readonly EmailHeader[],
  name: string,
): string[] {
  const lower = name.toLowerCase();
  return headers
    .filter((header) => header.name.toLowerCase() === lower)
    .map((header) => header.value);
}

export function readHeaderProperty(
  headers: readonly EmailHeader[],
  property: HeaderProperty,
): unknown {
  const values = headerValues(headers, property.name).map((value) =>
    convert(value, property.form),
  );
  if (property.all) return values;
  return values.length > 0 ? values[values.length - 1] : null;
}
