import { SetFailure, type EmailAddress } from '@mailless/jmap-core';
import {
  ComposeError,
  composeMessage,
  encodeText,
  formatAddresses,
  formatDate,
  formatDateWithOffset,
  formatGroupedAddresses,
  formatMessageIds,
  formatUrls,
  type ComposeHeader,
  type ComposePart,
} from './compose.js';
import {
  isFormAllowed,
  parseHeaderProperty,
  type HeaderProperty,
} from './headers.js';

/*
 * Turns the object given to `Email/set` create into an RFC 5322 message,
 * following the rules of RFC 8621 §4.6. Everything wrong with the object is
 * collected and reported together, each by the path of the property at fault,
 * such as `bodyStructure/subParts/1/size`.
 */

/** What `Email/set` create produces before the message is stored. */
export interface Draft {
  raw: Uint8Array;
  mailboxIds: unknown;
  keywords: unknown;
  receivedAt: unknown;
}

type Form = HeaderProperty['form'];

/** The properties that stand for one header field in a parsed form. */
const CONVENIENCE: Record<string, { header: string; form: Form }> = {
  from: { header: 'From', form: 'asAddresses' },
  sender: { header: 'Sender', form: 'asAddresses' },
  replyTo: { header: 'Reply-To', form: 'asAddresses' },
  to: { header: 'To', form: 'asAddresses' },
  cc: { header: 'Cc', form: 'asAddresses' },
  bcc: { header: 'Bcc', form: 'asAddresses' },
  subject: { header: 'Subject', form: 'asText' },
  sentAt: { header: 'Date', form: 'asDate' },
  messageId: { header: 'Message-ID', form: 'asMessageIds' },
  inReplyTo: { header: 'In-Reply-To', form: 'asMessageIds' },
  references: { header: 'References', form: 'asMessageIds' },
};
const BODY_PROPERTIES = ['textBody', 'htmlBody', 'attachments'];
const STORAGE_PROPERTIES = ['mailboxIds', 'keywords', 'receivedAt'];
const EMAIL_PROPERTIES = new Set([
  ...Object.keys(CONVENIENCE),
  ...BODY_PROPERTIES,
  ...STORAGE_PROPERTIES,
  'bodyStructure',
  'bodyValues',
]);
const PART_PROPERTIES = new Set([
  'partId',
  'blobId',
  'size',
  'type',
  'charset',
  'name',
  'disposition',
  'cid',
  'language',
  'location',
  'subParts',
]);

const MAX_PARTS = 100;
const MAX_DEPTH = 10;
const encoder = new TextEncoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects what is wrong, so that the client hears about all of it at once. */
class Problems {
  readonly properties: string[] = [];
  description: string | undefined;

  add(property: string, description: string): void {
    if (!this.properties.includes(property)) this.properties.push(property);
    this.description ??= description;
  }
}

/** One header value in the form the client gave it, as it goes on the wire. */
function formatValue(
  value: unknown,
  form: Form,
  property: string,
): ComposeHeader['value'] {
  const fail = (expected: string): never => {
    throw new ComposeError(`${property} must be ${expected}`, property);
  };
  switch (form) {
    case 'asRaw':
      return typeof value === 'string' ? value : fail('a string');
    case 'asText':
      return typeof value === 'string'
        ? encodeText(value, property)
        : fail('a string');
    case 'asAddresses': {
      const isList =
        Array.isArray(value) &&
        value.every(
          (item) =>
            isObject(item) &&
            typeof item['email'] === 'string' &&
            (item['name'] === undefined ||
              item['name'] === null ||
              typeof item['name'] === 'string'),
        );
      if (!isList) fail('a list of {name, email} objects');
      return formatAddresses(
        (value as Array<Record<string, unknown>>).map((item) => ({
          name: (item['name'] as string | null | undefined) ?? null,
          email: item['email'] as string,
        })),
        property,
      );
    }
    case 'asGroupedAddresses': {
      const isList =
        Array.isArray(value) &&
        value.every(
          (group) =>
            isObject(group) &&
            (group['name'] === null || typeof group['name'] === 'string') &&
            Array.isArray(group['addresses']) &&
            group['addresses'].every(
              (item) => isObject(item) && typeof item['email'] === 'string',
            ),
        );
      if (!isList) fail('a list of {name, addresses} groups');
      return formatGroupedAddresses(
        (value as Array<Record<string, unknown>>).map((group) => ({
          name: group['name'] as string | null,
          addresses: (group['addresses'] as EmailAddress[]).map((item) => ({
            name: item.name ?? null,
            email: item.email,
          })),
        })),
        property,
      );
    }
    case 'asMessageIds':
      return Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
        ? formatMessageIds(value as string[], property)
        : fail('a list of message ids');
    case 'asDate': {
      const formatted =
        typeof value === 'string' ? formatDateWithOffset(value) : null;
      return formatted ?? fail('a date');
    }
    case 'asURLs':
      return Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
        ? formatUrls(value as string[], property)
        : fail('a list of URLs');
  }
}

interface NamedHeader extends ComposeHeader {
  /** The property that set it, for telling the client about a clash. */
  property: string;
}

/**
 * Reads the header properties of an Email or of one body part: the parsed
 * conveniences such as `from`, and every `header:Name[:asForm][:all]`.
 */
function readHeaders(
  input: Record<string, unknown>,
  path: string,
  problems: Problems,
  withConveniences: boolean,
): NamedHeader[] {
  const headers: NamedHeader[] = [];
  const seen = new Map<string, string>();
  const claim = (header: string, property: string): boolean => {
    const lower = header.toLowerCase();
    if (seen.has(lower)) {
      problems.add(
        `${path}${property}`,
        `${seen.get(lower)} and ${property} both set the ${header} header`,
      );
      return false;
    }
    seen.set(lower, property);
    return true;
  };

  for (const [property, value] of Object.entries(input)) {
    let name: string;
    let form: Form;
    let all = false;
    if (withConveniences && CONVENIENCE[property]) {
      ({ header: name, form } = CONVENIENCE[property]);
    } else if (property.startsWith('header:')) {
      let parsed: HeaderProperty | null = null;
      try {
        parsed = parseHeaderProperty(property);
      } catch {
        // Reported below.
      }
      if (!parsed || !/^[\x21-\x39\x3b-\x7e]+$/.test(parsed.name)) {
        problems.add(
          `${path}${property}`,
          `"${property}" is not a valid header property`,
        );
        continue;
      }
      ({ name, form, all } = parsed);
      if (!isFormAllowed(name, form)) {
        problems.add(
          `${path}${property}`,
          `The ${name} header cannot be given in the ${form} form`,
        );
        continue;
      }
    } else {
      continue;
    }

    // A property given as null is a property not given.
    if (value === null || value === undefined) continue;
    if (!claim(name, property)) continue;
    // Errors name the header itself: `header:Subject`, whatever form was used.
    const reported = property.startsWith('header:')
      ? `${path}header:${name}`
      : `${path}${property}`;
    try {
      const values = all ? value : [value];
      if (!Array.isArray(values)) {
        throw new ComposeError(`${property} must be a list`, property);
      }
      for (const item of values) {
        const formatted = formatValue(item, form, property);
        // One message id only, where the header allows only one.
        if (
          form === 'asMessageIds' &&
          name.toLowerCase() === 'message-id' &&
          (item as unknown[]).length !== 1
        ) {
          throw new ComposeError(`${property} must contain exactly one id`);
        }
        if (formatted === '' && form !== 'asRaw') continue;
        headers.push({
          name,
          value: formatted,
          property,
          ...(form === 'asRaw' ? { raw: true } : {}),
        });
      }
    } catch (error) {
      if (!(error instanceof ComposeError)) throw error;
      problems.add(reported, error.message);
    }
  }
  return headers;
}

interface BodyContext {
  bodyValues: Record<string, unknown>;
  readBlob(blobId: string): Promise<Uint8Array | null>;
  missingBlobs: string[];
  partCount: number;
  problems: Problems;
  /** Header fields given on the outermost part, which belong to the message itself. */
  rootHeaders: NamedHeader[];
}

async function buildPart(
  value: unknown,
  path: string,
  ctx: BodyContext,
  depth: number,
  defaultType: string,
  isRoot = false,
): Promise<ComposePart> {
  const { problems } = ctx;
  const empty: ComposePart = { type: 'text/plain' };
  if (!isObject(value)) {
    problems.add(path, 'Each body part must be an object');
    return empty;
  }
  if (depth > MAX_DEPTH || ++ctx.partCount > MAX_PARTS) {
    problems.add(path, 'The body has too many parts');
    return empty;
  }
  const at = (property: string) => `${path}/${property}`;
  const given = (property: string) =>
    value[property] !== undefined && value[property] !== null;

  for (const property of Object.keys(value)) {
    if (property === 'headers') {
      problems.add(
        at(property),
        'Set each header as a property of its own, not through headers',
      );
    } else if (
      !PART_PROPERTIES.has(property) &&
      !property.startsWith('header:')
    ) {
      problems.add(at(property), `"${property}" is not a body part property`);
    }
  }

  const text = (property: string): string | null => {
    if (!given(property)) return null;
    if (typeof value[property] !== 'string') {
      problems.add(at(property), `${property} must be a string`);
      return null;
    }
    return value[property];
  };
  const subParts = value['subParts'];
  const isMultipart = Array.isArray(subParts);
  const type = (
    text('type') ?? (isMultipart ? 'multipart/mixed' : defaultType)
  ).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    problems.add(at('type'), `"${type}" is not a media type`);
  }

  const headers = readHeaders(value, `${path}/`, problems, false);
  const partHeaders: ComposeHeader[] = [];
  // What the part's own properties already say cannot be said again as a header.
  const taken: Record<string, string> = {
    'content-type': 'type',
    'content-disposition': 'disposition',
    'content-id': 'cid',
    'content-language': 'language',
    'content-location': 'location',
  };
  for (const header of headers) {
    const lower = header.name.toLowerCase();
    if (lower === 'content-transfer-encoding') {
      problems.add(
        at(header.property),
        'The transfer encoding is chosen by the server',
      );
    } else if (
      taken[lower] &&
      (lower === 'content-type' || given(taken[lower]))
    ) {
      problems.add(
        at(header.property),
        `Give the ${header.name} header through the ${taken[lower]} property`,
      );
    } else if (isRoot && !lower.startsWith('content-')) {
      ctx.rootHeaders.push({ ...header, property: at(header.property) });
    } else {
      partHeaders.push(header);
    }
  }

  let language: string[] | null = null;
  if (given('language')) {
    if (
      Array.isArray(value['language']) &&
      value['language'].every((tag) => typeof tag === 'string')
    ) {
      language = value['language'] as string[];
    } else {
      problems.add(at('language'), 'language must be a list of language tags');
    }
  }
  const part: ComposePart = {
    type,
    name: text('name'),
    disposition: text('disposition'),
    cid: text('cid'),
    language,
    location: text('location'),
    headers: partHeaders,
  };

  const hasPartId = given('partId');
  const hasBlobId = given('blobId');
  if (isMultipart) {
    if (!type.startsWith('multipart/')) {
      problems.add(
        at('type'),
        'A part with sub-parts must be a multipart type',
      );
    }
    for (const property of ['partId', 'blobId', 'charset', 'size']) {
      if (given(property)) {
        problems.add(
          at(property),
          'A multipart part has no content of its own',
        );
      }
    }
    part.subParts = [];
    for (const [index, child] of subParts.entries()) {
      part.subParts.push(
        await buildPart(
          child,
          `${at('subParts')}/${index}`,
          ctx,
          depth + 1,
          type === 'multipart/digest' ? 'message/rfc822' : 'text/plain',
        ),
      );
    }
    return part;
  }
  if (given('subParts')) {
    problems.add(at('subParts'), 'subParts must be a list');
  }
  if (type.startsWith('multipart/')) {
    problems.add(at('subParts'), 'A multipart part needs sub-parts');
    return part;
  }

  if (hasPartId === hasBlobId) {
    problems.add(at('partId'), 'A part needs one of partId and blobId');
    problems.add(at('blobId'), 'A part needs one of partId and blobId');
    return part;
  }

  if (hasPartId) {
    // The content is in bodyValues, so its size and encoding are the server's to work out.
    for (const property of ['charset', 'size']) {
      if (given(property)) {
        problems.add(at(property), `${property} cannot be given with a partId`);
      }
    }
    const partId = String(value['partId']);
    const bodyValue = Object.prototype.hasOwnProperty.call(
      ctx.bodyValues,
      partId,
    )
      ? ctx.bodyValues[partId]
      : undefined;
    if (!isObject(bodyValue)) {
      problems.add(at('partId'), `There is no body value for part "${partId}"`);
      return part;
    }
    for (const flag of ['isTruncated', 'isEncodingProblem']) {
      if (bodyValue[flag] === true) {
        problems.add(
          `bodyValues/${partId}/${flag}`,
          'A truncated or damaged body value cannot be stored',
        );
      }
    }
    if (typeof bodyValue['value'] !== 'string') {
      problems.add(`bodyValues/${partId}/value`, 'value must be a string');
      return part;
    }
    if (type.startsWith('text/')) {
      part.charset = 'utf-8';
      part.content = encoder.encode(
        bodyValue['value'].replace(/\r?\n/g, '\r\n'),
      );
    } else {
      part.content = encoder.encode(bodyValue['value']);
    }
    return part;
  }

  if (typeof value['blobId'] !== 'string') {
    problems.add(at('blobId'), 'blobId must be a string');
    return part;
  }
  // A size given with a blob is allowed and ignored: the blob has the size it has.
  const content = await ctx.readBlob(value['blobId']);
  if (!content) ctx.missingBlobs.push(value['blobId']);
  else part.content = content;
  part.charset = text('charset');
  return part;
}

async function buildBody(
  input: Record<string, unknown>,
  ctx: BodyContext,
): Promise<ComposePart> {
  const { problems } = ctx;
  const flat = BODY_PROPERTIES.filter(
    (property) => input[property] !== undefined && input[property] !== null,
  );

  if (input['bodyStructure'] !== undefined && input['bodyStructure'] !== null) {
    for (const property of flat) {
      problems.add(
        property,
        'Give either bodyStructure or textBody, htmlBody and attachments, not both',
      );
    }
    return buildPart(
      input['bodyStructure'],
      'bodyStructure',
      ctx,
      0,
      'text/plain',
      true,
    );
  }

  const list = (property: string): unknown[] => {
    const value = input[property] ?? [];
    if (!Array.isArray(value)) {
      problems.add(property, `${property} must be a list`);
      return [];
    }
    return value;
  };
  const single = async (property: string, type: string) => {
    const parts = list(property);
    if (parts.length === 0) return undefined;
    if (parts.length > 1) {
      problems.add(property, `${property} may contain only one part`);
    }
    const part = await buildPart(parts[0], `${property}/0`, ctx, 1, type);
    if (part.type !== type) {
      problems.add(
        `${property}/0/type`,
        `The part in ${property} must be ${type}`,
      );
    }
    return part;
  };

  const text = await single('textBody', 'text/plain');
  const html = await single('htmlBody', 'text/html');
  const attachments: ComposePart[] = [];
  for (const [index, attachment] of list('attachments').entries()) {
    const part = await buildPart(
      attachment,
      `attachments/${index}`,
      ctx,
      1,
      'application/octet-stream',
    );
    attachments.push({
      ...part,
      disposition: part.disposition ?? 'attachment',
    });
  }

  const main: ComposePart =
    text && html
      ? { type: 'multipart/alternative', subParts: [text, html] }
      : (text ?? html ?? { type: 'text/plain', charset: 'utf-8' });
  return attachments.length > 0
    ? { type: 'multipart/mixed', subParts: [main, ...attachments] }
    : main;
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
  const problems = new Problems();
  for (const property of Object.keys(input)) {
    if (property === 'headers') {
      problems.add(
        property,
        'Set each header as a property of its own, not through headers',
      );
    } else if (
      !EMAIL_PROPERTIES.has(property) &&
      !property.startsWith('header:')
    ) {
      problems.add(
        property,
        `"${property}" cannot be set when creating an email`,
      );
    }
  }

  const headers = readHeaders(input, '', problems, true);
  for (const header of headers) {
    if (header.name.toLowerCase().startsWith('content-')) {
      problems.add(
        header.property,
        'Content headers belong to body parts, not to the email',
      );
    }
  }

  const bodyValues = input['bodyValues'] ?? {};
  if (!isObject(bodyValues)) {
    problems.add('bodyValues', 'bodyValues must be an object');
  }
  const ctx: BodyContext = {
    bodyValues: isObject(bodyValues) ? bodyValues : {},
    readBlob,
    missingBlobs: [],
    partCount: 0,
    problems,
    rootHeaders: [],
  };
  const body = await buildBody(input, ctx);

  // Headers given on the outermost part are the message's; none may be set twice.
  const names = new Set(headers.map((header) => header.name.toLowerCase()));
  for (const header of ctx.rootHeaders) {
    if (names.has(header.name.toLowerCase())) {
      problems.add(
        header.property,
        `The ${header.name} header is already set on the email`,
      );
    } else {
      headers.push(header);
    }
  }
  for (const header of ctx.rootHeaders) names.add(header.name.toLowerCase());

  if (problems.properties.length > 0) {
    throw new SetFailure('invalidProperties', problems.description, {
      properties: problems.properties,
    });
  }
  if (ctx.missingBlobs.length > 0) {
    throw new SetFailure('blobNotFound', undefined, {
      notFound: [...new Set(ctx.missingBlobs)],
    });
  }

  // The two headers every message must have, when the client gave none.
  if (!names.has('date')) {
    headers.push({ name: 'Date', value: formatDate(new Date()), property: '' });
  }
  if (!names.has('message-id')) {
    const from = headers.find((header) => header.name.toLowerCase() === 'from');
    const domain =
      /@([A-Za-z0-9.-]+)>?\s*$/.exec(from?.value ?? '')?.[1] ??
      'mailless.invalid';
    headers.push({
      name: 'Message-ID',
      value: `<${crypto.randomUUID()}@${domain}>`,
      property: '',
    });
  }

  try {
    return {
      raw: composeMessage(
        headers.map(({ name, value, raw }) => ({
          name,
          value,
          ...(raw ? { raw } : {}),
        })),
        body,
      ),
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
