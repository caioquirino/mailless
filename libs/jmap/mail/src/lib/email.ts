import {
  applyPatch,
  DEFAULT_BODY_PROPERTIES,
  DEFAULT_EMAIL_PROPERTIES,
  GetArgumentsSchema,
  IdSchema,
  MethodError,
  PatchError,
  patchedProperties,
  QueryArgumentsSchema,
  QueryChangesArgumentsSchema,
  SetArgumentsSchema,
  SetFailure,
  UnsignedIntSchema,
  UTCDateSchema,
  type Comparator,
  type EmailAddress,
  type EmailHeader,
  type SetError,
  type SetResponse,
} from '@mailless/jmap-core';
import { z } from 'zod';
import { usedOctets } from './quota.js';
import { buildDraft } from './draft.js';
import { sendVacationReply } from './vacation.js';
import { destroyEmail, getEmail, mutateThread } from './email-store.js';
import {
  headerAsText,
  headerValues,
  isFormAllowed,
  parseHeaderProperty,
  readHeaderProperty,
  type HeaderProperty,
} from './headers.js';
import {
  buildBodyLayout,
  InvalidMessageError,
  parseMessage,
  partText,
  type ParsedMessage,
  splitPartBlobId,
} from './mime.js';
import {
  bodyText,
  extractText,
  highlight,
  loadSearchText,
  matchesSearch,
  MAX_SNIPPET_BYTES,
  parseSearch,
  searchableHeaders,
  type EmailTextValue,
  type SearchQuery,
} from './search.js';
import {
  baseSubject,
  BODY_LAYOUT_VERSION,
  EMAIL,
  EMAIL_DELIVERY,
  isValidKeyword,
  MAILBOX,
  THREAD,
  type EmailRecord,
  type EmailValue,
  type MailboxRecord,
  type StoredBodyPart,
} from './model.js';

import {
  changesSince,
  compareStrings,
  filterAndSort,
  filterUses,
  generateId,
  loadForGet,
  paginate,
  parseArguments,
  queryChanges,
  requireAccount,
  requireCopyAccounts,
  requiredConditionValues,
  resolveCreationReference,
  standardChanges,
  standardSet,
  toChangesResponse,
  toUtcDate,
  validateFilter,
  type CompareFn,
  type MethodContext,
  type MethodHandler,
  type QuerySpec,
  type SetArgumentsLike,
  type SetSpec,
  type WriteOp,
} from '@mailless/jmap-engine';
const EMAIL_PROPERTIES = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'size',
  'receivedAt',
  'headers',
  'messageId',
  'inReplyTo',
  'references',
  'sender',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'sentAt',
  'hasAttachment',
  'preview',
  'bodyStructure',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
];

const BODY_PROPERTIES = [
  'partId',
  'blobId',
  'size',
  'headers',
  'name',
  'type',
  'charset',
  'disposition',
  'cid',
  'language',
  'location',
  'subParts',
];

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const LAYOUT_PROPERTIES = [
  'bodyStructure',
  'textBody',
  'htmlBody',
  'attachments',
  'bodyValues',
];

/** Reads a blob by id: an uploaded blob, a stored message, or one decoded part of a stored message. */
export async function readBlob(
  ctx: MethodContext,
  blobId: string,
): Promise<Uint8Array | null> {
  const accountId = ctx.auth.accountId;
  // Ids made here never contain "-", so an id of that shape can only name a part.
  // Deciding by shape avoids asking storage for an object that cannot exist.
  const partReference = splitPartBlobId(blobId);
  if (!partReference) return ctx.blobs.get(accountId, blobId);

  // The message may itself be a part of another: a message attached to a message.
  const message = await readBlob(ctx, partReference.messageBlobId);
  if (!message) return null;
  try {
    const parsed = await parseMessage(message);
    return (
      parsed.parts.find((part) => part.partId === partReference.partId)?.data ??
      null
    );
  } catch (error) {
    if (error instanceof InvalidMessageError) return null;
    throw error;
  }
}

// ---------------------------------------------------------------- Email/get

interface PropertySelection {
  plain: string[];
  headers: Map<string, HeaderProperty>;
}

function selectWithHeaders(
  requested: readonly string[],
  valid: readonly string[],
  kind: string,
): PropertySelection {
  const selection: PropertySelection = { plain: [], headers: new Map() };
  for (const property of new Set(requested)) {
    const header = parseHeaderProperty(property);
    if (header) {
      if (!isFormAllowed(header.name, header.form)) {
        throw new MethodError(
          'invalidArguments',
          `The ${header.name} header cannot be read in the ${header.form} form`,
        );
      }
      selection.headers.set(property, header);
    } else if (valid.includes(property)) selection.plain.push(property);
    else {
      throw new MethodError(
        'invalidArguments',
        `Unknown ${kind} property "${property}"`,
      );
    }
  }
  return selection;
}

function leafParts(part: StoredBodyPart): StoredBodyPart[] {
  return part.subParts ? part.subParts.flatMap(leafParts) : [part];
}

function projectPart(
  part: StoredBodyPart,
  selection: PropertySelection,
  /** The email's headers, which are also those of its outermost part. */
  rootHeaders?: EmailHeader[],
  /** Within bodyStructure a multipart always shows its parts: without them the tree is no tree. */
  asTree = false,
): Record<string, unknown> {
  const headers = rootHeaders ?? part.headers ?? [];
  const result: Record<string, unknown> = {};
  for (const property of selection.plain) {
    if (property === 'headers') result[property] = headers;
    else if (property === 'language' || property === 'location') {
      result[property] = part[property] ?? null;
    } else if (property === 'subParts') {
      result[property] =
        part.subParts?.map((child) =>
          projectPart(child, selection, undefined, asTree),
        ) ?? null;
    } else {
      result[property] = part[property as keyof StoredBodyPart];
    }
  }
  for (const [property, header] of selection.headers) {
    result[property] = readHeaderProperty(headers, header);
  }
  if (asTree && part.subParts && !('subParts' in result)) {
    result['subParts'] = part.subParts.map((child) =>
      projectPart(child, selection, undefined, true),
    );
  }
  return result;
}

function truncateUtf8(
  text: string,
  maxBytes: number,
): { value: string; isTruncated: boolean } {
  if (maxBytes === 0) return { value: text, isTruncated: false };
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { value: text, isTruncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return { value: decoder.decode(bytes.subarray(0, end)), isTruncated: true };
}

async function loadBodyValues(
  ctx: MethodContext,
  email: EmailValue,
  partIds: ReadonlySet<string>,
  maxBytes: number,
  /** The message, when the caller has it parsed already. */
  known?: ParsedMessage,
): Promise<Record<string, unknown>> {
  if (partIds.size === 0) return {};
  let parsed = known;
  if (!parsed) {
    const raw = await ctx.blobs.get(ctx.auth.accountId, email.blobId);
    if (!raw) return {};
    parsed = await parseMessage(raw);
  }
  const values: Record<string, unknown> = {};
  for (const part of parsed.parts) {
    if (part.partId === null || !partIds.has(part.partId)) continue;
    const { value, isEncodingProblem } = partText(part);
    values[part.partId] = {
      ...truncateUtf8(value, maxBytes),
      isEncodingProblem,
    };
  }
  return values;
}

const EmailGetArgumentsSchema = GetArgumentsSchema.extend({
  bodyProperties: z.array(z.string()).nullish(),
  fetchTextBodyValues: z.boolean().optional(),
  fetchHTMLBodyValues: z.boolean().optional(),
  fetchAllBodyValues: z.boolean().optional(),
  maxBodyValueBytes: UnsignedIntSchema.optional(),
});
type EmailGetArguments = z.infer<typeof EmailGetArgumentsSchema>;

async function toEmailObject(
  ctx: MethodContext,
  record: EmailRecord,
  args: EmailGetArguments,
  selection: PropertySelection,
  bodySelection: PropertySelection,
  /** The message, when the caller has it parsed already. */
  parsed?: ParsedMessage,
): Promise<Record<string, unknown>> {
  let email = record.value;
  // An email stored under the older, simplified layout: read the real one from the message.
  if (
    email.layout !== BODY_LAYOUT_VERSION &&
    selection.plain.some((property) => LAYOUT_PROPERTIES.includes(property))
  ) {
    const raw = await ctx.blobs.get(ctx.auth.accountId, email.blobId);
    if (raw) {
      try {
        email = {
          ...email,
          ...buildBodyLayout(await parseMessage(raw), email.blobId),
        };
      } catch (error) {
        if (!(error instanceof InvalidMessageError)) throw error;
      }
    }
  }
  const leaves = leafParts(email.bodyStructure);
  const byPartId = new Map(leaves.map((part) => [part.partId, part]));
  const partList = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const part = byPartId.get(id);
      return part
        ? [
            projectPart(
              part,
              bodySelection,
              // A message that is a single part: that part's headers are the email's.
              part === email.bodyStructure ? email.headers : undefined,
            ),
          ]
        : [];
    });

  const result: Record<string, unknown> = {};
  for (const property of selection.plain) {
    switch (property) {
      case 'id':
        result[property] = record.id;
        break;
      case 'bodyStructure':
        result[property] = projectPart(
          email.bodyStructure,
          bodySelection,
          email.headers,
          true,
        );
        break;
      case 'textBody':
      case 'htmlBody':
      case 'attachments':
        result[property] = partList(email[property]);
        break;
      case 'bodyValues': {
        const wanted = new Set<string>();
        const isText = (id: string) =>
          byPartId.get(id)?.type.startsWith('text/') ?? false;
        if (args.fetchTextBodyValues) {
          for (const id of email.textBody) if (isText(id)) wanted.add(id);
        }
        if (args.fetchHTMLBodyValues) {
          for (const id of email.htmlBody) if (isText(id)) wanted.add(id);
        }
        if (args.fetchAllBodyValues) {
          for (const part of leaves) {
            if (part.partId !== null && isText(part.partId)) {
              wanted.add(part.partId);
            }
          }
        }
        result[property] = await loadBodyValues(
          ctx,
          email,
          wanted,
          args.maxBodyValueBytes ?? 0,
          parsed,
        );
        break;
      }
      case 'receivedAt':
        // Kept to the millisecond so that mail arriving together stays in order; shown to the second.
        result[property] = email.receivedAt?.replace(/\.\d+Z$/, 'Z') ?? null;
        break;
      default:
        result[property] = email[property as keyof EmailValue];
    }
  }
  for (const [property, header] of selection.headers) {
    result[property] = readHeaderProperty(email.headers, header);
  }
  return result;
}

// -------------------------------------------------------------- Email/query

interface EmailItem {
  id: string;
  email: EmailValue;
  /** Present when the filter searches inside messages. */
  text?: EmailTextValue;
}

type ThreadIndex = Map<string, EmailValue[]>;

const isString = (value: unknown): boolean => typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isUnsignedInt = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isDate = (value: unknown): boolean =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isString);

const CONDITION_VALIDATORS: Record<string, (value: unknown) => boolean> = {
  inMailbox: isString,
  inMailboxOtherThan: isStringArray,
  before: isDate,
  after: isDate,
  minSize: isUnsignedInt,
  maxSize: isUnsignedInt,
  allInThreadHaveKeyword: isString,
  someInThreadHaveKeyword: isString,
  noneInThreadHaveKeyword: isString,
  hasKeyword: isString,
  notKeyword: isString,
  hasAttachment: isBoolean,
  text: isString,
  body: isString,
  from: isString,
  to: isString,
  cc: isString,
  bcc: isString,
  subject: isString,
  header: (value) =>
    isStringArray(value) &&
    ((value as string[]).length === 1 || (value as string[]).length === 2),
};

/** Conditions that look inside messages, for which the searchable text has to be loaded. */
const TEXT_CONDITIONS = ['text', 'body'];

const THREAD_KEYWORD_PROPERTIES = [
  'allInThreadHaveKeyword',
  'someInThreadHaveKeyword',
  'noneInThreadHaveKeyword',
];

function contains(haystack: string | null, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

function matchesAddress(
  addresses: EmailAddress[] | null,
  needle: string,
): boolean {
  return (addresses ?? []).some(
    (address) =>
      contains(address.name, needle) || contains(address.email, needle),
  );
}

function sortKey(addresses: EmailAddress[] | null): string {
  const first = addresses?.[0];
  return first ? (first.name ?? first.email) : '';
}

function threadKeywordCount(
  threads: ThreadIndex,
  email: EmailValue,
  keyword: string,
): { having: number; total: number } {
  const members = threads.get(email.threadId) ?? [email];
  return {
    having: members.filter((member) => member.keywords[keyword]).length,
    total: members.length,
  };
}

function emailQuerySpec(threads: ThreadIndex): QuerySpec<EmailItem> {
  const searches = new Map<string, SearchQuery>();
  const search = (text: string): SearchQuery => {
    let query = searches.get(text);
    if (!query) searches.set(text, (query = parseSearch(text)));
    return query;
  };
  const headerTexts = new WeakMap<EmailValue, string>();
  const headerText = (email: EmailValue): string => {
    let text = headerTexts.get(email);
    if (text === undefined) {
      headerTexts.set(email, (text = searchableHeaders(email)));
    }
    return text;
  };

  return {
    validateCondition(condition) {
      for (const [key, value] of Object.entries(condition)) {
        const validator = CONDITION_VALIDATORS[key];
        if (!validator) {
          throw new MethodError(
            'invalidArguments',
            `Unknown Email filter property "${key}"`,
          );
        }
        if (!validator(value)) {
          throw new MethodError(
            'invalidArguments',
            `Invalid value for Email filter property "${key}"`,
          );
        }
      }
    },

    matches({ email, text }, condition) {
      for (const [key, value] of Object.entries(condition)) {
        let ok: boolean;
        switch (key) {
          case 'text':
            ok = matchesSearch(search(value as string), [
              headerText(email),
              text?.names ?? '',
              text?.body ?? '',
            ]);
            break;
          case 'body':
            ok = matchesSearch(search(value as string), [text?.body ?? '']);
            break;
          case 'inMailbox':
            ok = email.mailboxIds[value as string] === true;
            break;
          case 'inMailboxOtherThan':
            ok = Object.keys(email.mailboxIds).some(
              (id) => !(value as string[]).includes(id),
            );
            break;
          case 'before':
            ok = Date.parse(email.receivedAt) < Date.parse(value as string);
            break;
          case 'after':
            ok = Date.parse(email.receivedAt) >= Date.parse(value as string);
            break;
          case 'minSize':
            ok = email.size >= (value as number);
            break;
          case 'maxSize':
            ok = email.size < (value as number);
            break;
          case 'allInThreadHaveKeyword': {
            const count = threadKeywordCount(threads, email, value as string);
            ok = count.having === count.total;
            break;
          }
          case 'someInThreadHaveKeyword':
            ok = threadKeywordCount(threads, email, value as string).having > 0;
            break;
          case 'noneInThreadHaveKeyword':
            ok =
              threadKeywordCount(threads, email, value as string).having === 0;
            break;
          case 'hasKeyword':
            ok = email.keywords[value as string] === true;
            break;
          case 'notKeyword':
            ok = email.keywords[value as string] !== true;
            break;
          case 'hasAttachment':
            ok = email.hasAttachment === value;
            break;
          case 'from':
          case 'to':
          case 'cc':
          case 'bcc':
            ok = matchesAddress(email[key], value as string);
            break;
          case 'subject':
            ok = contains(email.subject, value as string);
            break;
          case 'header': {
            const [name, text] = value as [string, string?];
            const values = headerValues(email.headers, name);
            ok =
              text === undefined
                ? values.length > 0
                : values.some((v) => contains(headerAsText(v), text));
            break;
          }
          default:
            ok = false;
        }
        if (!ok) return false;
      }
      return true;
    },

    comparator(comparator: Comparator): CompareFn<EmailItem> {
      const keyword = comparator['keyword'];
      const needsKeyword = () => {
        if (typeof keyword !== 'string') {
          throw new MethodError(
            'invalidArguments',
            `Sorting by "${comparator.property}" requires a keyword`,
          );
        }
        return keyword;
      };

      switch (comparator.property) {
        case 'receivedAt':
          return (a, b) =>
            Date.parse(a.email.receivedAt) - Date.parse(b.email.receivedAt);
        case 'sentAt':
          return (a, b) =>
            Date.parse(a.email.sentAt ?? a.email.receivedAt) -
            Date.parse(b.email.sentAt ?? b.email.receivedAt);
        case 'size':
          return (a, b) => a.email.size - b.email.size;
        case 'from':
          return (a, b) =>
            compareStrings(
              sortKey(a.email.from),
              sortKey(b.email.from),
              comparator.collation,
            );
        case 'to':
          return (a, b) =>
            compareStrings(
              sortKey(a.email.to),
              sortKey(b.email.to),
              comparator.collation,
            );
        case 'subject':
          return (a, b) =>
            compareStrings(
              baseSubject(a.email.subject),
              baseSubject(b.email.subject),
              comparator.collation,
            );
        case 'hasKeyword': {
          const name = needsKeyword();
          return (a, b) =>
            Number(a.email.keywords[name] === true) -
            Number(b.email.keywords[name] === true);
        }
        case 'allInThreadHaveKeyword': {
          const name = needsKeyword();
          const all = (email: EmailValue) => {
            const count = threadKeywordCount(threads, email, name);
            return Number(count.having === count.total);
          };
          return (a, b) => all(a.email) - all(b.email);
        }
        case 'someInThreadHaveKeyword': {
          const name = needsKeyword();
          const some = (email: EmailValue) =>
            Number(threadKeywordCount(threads, email, name).having > 0);
          return (a, b) => some(a.email) - some(b.email);
        }
        default:
          throw new MethodError(
            'unsupportedSort',
            `Emails cannot be sorted by "${comparator.property}"`,
          );
      }
    },
  };
}

export const EMAIL_SORT_OPTIONS = [
  'receivedAt',
  'sentAt',
  'size',
  'from',
  'to',
  'subject',
  'hasKeyword',
  'allInThreadHaveKeyword',
  'someInThreadHaveKeyword',
];

const EmailQueryArgumentsSchema = QueryArgumentsSchema.extend({
  collapseThreads: z.boolean().optional(),
});

async function listAllEmails(ctx: MethodContext): Promise<EmailRecord[]> {
  return (await ctx.store.list(
    ctx.auth.accountId,
    EMAIL,
  )) as unknown as EmailRecord[];
}

// ---------------------------------------------------------------- Email/set

function invalid(properties: string[], description: string): SetFailure {
  return new SetFailure('invalidProperties', description, { properties });
}

function isFlagMap(value: unknown): value is Record<string, true> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((flag) => flag === true)
  );
}

function normaliseKeywords(input: unknown): Record<string, true> {
  if (!isFlagMap(input)) {
    throw invalid(['keywords'], 'keywords must map keyword names to true');
  }
  const keywords: Record<string, true> = {};
  for (const keyword of Object.keys(input)) {
    const lower = keyword.toLowerCase();
    if (!isValidKeyword(lower)) {
      throw invalid(['keywords'], `"${keyword}" is not a valid keyword`);
    }
    keywords[lower] = true;
  }
  return keywords;
}

async function normaliseMailboxIds(
  ctx: MethodContext,
  input: unknown,
): Promise<Record<string, true>> {
  if (!isFlagMap(input)) {
    throw invalid(['mailboxIds'], 'mailboxIds must map mailbox ids to true');
  }
  const mailboxIds: Record<string, true> = {};
  for (const reference of Object.keys(input)) {
    const id = resolveCreationReference(ctx, reference);
    if (id === undefined) {
      throw invalid(['mailboxIds'], `Unknown creation id "${reference}"`);
    }
    mailboxIds[id] = true;
  }
  const ids = Object.keys(mailboxIds);
  if (ids.length === 0) {
    throw invalid(['mailboxIds'], 'An email must be in at least one mailbox');
  }
  const existing = await ctx.store.get(ctx.auth.accountId, MAILBOX, ids);
  if (existing.length !== ids.length) {
    throw invalid(['mailboxIds'], 'At least one mailbox does not exist');
  }
  return mailboxIds;
}

function sameKeys(a: object, b: object): boolean {
  return (
    Object.keys(a).sort().join('\u0000') ===
    Object.keys(b).sort().join('\u0000')
  );
}

const UPDATABLE_PROPERTIES = ['keywords', 'mailboxIds'];

async function updateEmail(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<null> {
  const unknown = patchedProperties(patch).filter(
    (property) => !UPDATABLE_PROPERTIES.includes(property),
  );
  if (unknown.length > 0) {
    throw invalid(unknown, 'Only keywords and mailboxIds can be changed');
  }

  const record = await getEmail(ctx, id);
  if (!record) throw new SetFailure('notFound');

  await mutateThread(ctx, record.value.threadId, async (emails) => {
    const current = emails.find((email) => email.id === id);
    if (!current) throw new SetFailure('notFound');

    let patched: { keywords: unknown; mailboxIds: unknown };
    try {
      patched = applyPatch(
        {
          keywords: current.value.keywords,
          mailboxIds: current.value.mailboxIds,
        },
        patch,
      );
    } catch (error) {
      if (error instanceof PatchError) {
        throw new SetFailure('invalidPatch', error.message);
      }
      throw error;
    }

    const keywords = normaliseKeywords(patched.keywords);
    const mailboxIds = await normaliseMailboxIds(ctx, patched.mailboxIds);
    const changedProperties = [
      ...(sameKeys(keywords, current.value.keywords) ? [] : ['keywords']),
      ...(sameKeys(mailboxIds, current.value.mailboxIds) ? [] : ['mailboxIds']),
    ];
    if (changedProperties.length === 0) return [];

    return [
      {
        kind: 'update',
        id,
        value: { ...current.value, keywords, mailboxIds },
        changedProperties,
      },
    ];
  });
  return null;
}

async function createEmail(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  const draft = await buildDraft(input, (blobId) => readBlob(ctx, blobId));

  if (draft.receivedAt !== undefined && draft.receivedAt !== null) {
    if (!UTCDateSchema.safeParse(draft.receivedAt).success) {
      throw invalid(['receivedAt'], 'receivedAt must be a UTC date');
    }
  }
  const imported = await importMessage(ctx, draft.raw, {
    // Checked by importMessage; it is the client's value as given.
    mailboxIds: (draft.mailboxIds ?? {}) as Record<string, true>,
    keywords: draft.keywords as Record<string, true>,
    ...(typeof draft.receivedAt === 'string'
      ? { receivedAt: draft.receivedAt }
      : {}),
  });
  return { ...imported };
}

const emailSetSpec: SetSpec = {
  type: EMAIL,
  create: createEmail,
  update: updateEmail,
  destroy: async (ctx, id) => {
    if (!(await destroyEmail(ctx, id))) throw new SetFailure('notFound');
  },
};

/** Email/set, callable from other methods that change emails as a side effect. */
export function runEmailSet(
  ctx: MethodContext,
  args: SetArgumentsLike,
): Promise<SetResponse<Record<string, unknown>>> {
  return standardSet(ctx, emailSetSpec, args);
}

// ------------------------------------------------------------- Email/import

export interface ImportOptions {
  /** Mailbox ids; keys may be `#creationId` references within a request. */
  mailboxIds?: Record<string, true>;
  /**
   * Deliver to the mailbox with this role instead of naming ids. Falls back
   * to the inbox when no mailbox has the role. Exactly one of `mailboxIds`
   * and `mailboxRole` must be given.
   */
  mailboxRole?: string;
  keywords?: Record<string, true>;
  receivedAt?: string;
  /**
   * Makes the import repeatable: a second call with the same key returns the
   * email the first one created. Use the delivery id of the inbound message.
   */
  idempotencyKey?: string;
  /**
   * Set for mail arriving from outside, as opposed to a message a client
   * uploads. It moves the EmailDelivery state, which is what clients watch to
   * learn of new mail.
   */
  delivery?: boolean;
}

export interface ImportedEmail {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
}

const MAX_THREAD_LOOKUPS = 16;

async function findThread(
  ctx: MethodContext,
  message: {
    messageId: string[] | null;
    inReplyTo: string[] | null;
    references: string[] | null;
    subject: string | null;
  },
): Promise<string | undefined> {
  const subject = baseSubject(message.subject);
  // Most specific first: what it replies to, then the reference chain newest-first, then itself.
  const keys = [
    ...new Set([
      ...(message.inReplyTo ?? []),
      ...[...(message.references ?? [])].reverse(),
      ...(message.messageId ?? []),
    ]),
  ].slice(0, MAX_THREAD_LOOKUPS);
  for (const key of keys) {
    const related = (await ctx.store.list(ctx.auth.accountId, EMAIL, {
      name: 'threadKey',
      value: key,
    })) as unknown as EmailRecord[];
    const match = related.find(
      (record) =>
        !ctx.mail.threadsRequireSameSubject ||
        baseSubject(record.value.subject) === subject,
    );
    if (match) return match.value.threadId;
  }
  return undefined;
}

async function resolveMailboxIds(
  ctx: MethodContext,
  options: ImportOptions,
): Promise<Record<string, true>> {
  if (
    (options.mailboxIds === undefined) ===
    (options.mailboxRole === undefined)
  ) {
    throw invalid(
      ['mailboxIds'],
      'Give exactly one of mailboxIds and mailboxRole',
    );
  }
  if (options.mailboxIds !== undefined) {
    return normaliseMailboxIds(ctx, options.mailboxIds);
  }

  const mailboxes = (await ctx.store.list(
    ctx.auth.accountId,
    MAILBOX,
  )) as unknown as MailboxRecord[];
  const target =
    mailboxes.find((mailbox) => mailbox.value.role === options.mailboxRole) ??
    mailboxes.find((mailbox) => mailbox.value.role === 'inbox');
  if (!target) {
    throw invalid(['mailboxIds'], 'The account has no inbox to deliver to');
  }
  return { [target.id]: true };
}

async function stableSuffix(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  let hex = '';
  for (const byte of new Uint8Array(digest).subarray(0, 12)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const DELIVERY_COUNTER = 'counter';

/** Moves the EmailDelivery state. The counter record exists only to be written to. */
async function deliveryOps(ctx: MethodContext): Promise<WriteOp[]> {
  const [counter] = await ctx.store.get(ctx.auth.accountId, EMAIL_DELIVERY, [
    DELIVERY_COUNTER,
  ]);
  return [
    counter
      ? {
          kind: 'increment',
          type: EMAIL_DELIVERY,
          id: DELIVERY_COUNTER,
          deltas: { count: 1 },
        }
      : {
          kind: 'create',
          type: EMAIL_DELIVERY,
          id: DELIVERY_COUNTER,
          value: { count: 1 },
        },
  ];
}

/**
 * Stores a raw RFC 5322 message as an Email. This is the one entry point for
 * new mail, used by Email/import and by inbound delivery.
 */
export async function importMessage(
  ctx: MethodContext,
  raw: Uint8Array,
  options: ImportOptions,
): Promise<ImportedEmail> {
  const accountId = ctx.auth.accountId;

  // With an idempotency key every id is derived from it, so a repeat finds the first result.
  const suffix =
    options.idempotencyKey === undefined
      ? undefined
      : await stableSuffix(options.idempotencyKey);
  const id = suffix ? `em${suffix}` : generateId('em');
  const blobId = suffix ? `bm${suffix}` : generateId('bm');
  const existing = async (): Promise<ImportedEmail | undefined> => {
    if (!suffix) return undefined;
    const record = await getEmail(ctx, id);
    return record
      ? {
          id,
          blobId: record.value.blobId,
          threadId: record.value.threadId,
          size: record.value.size,
        }
      : undefined;
  };
  const already = await existing();
  if (already) return already;

  const mailboxIds = await resolveMailboxIds(ctx, options);
  const keywords = normaliseKeywords(options.keywords ?? {});

  let parsed;
  try {
    parsed = await parseMessage(raw);
  } catch (error) {
    if (error instanceof InvalidMessageError) {
      throw new SetFailure('invalidEmail', error.message);
    }
    throw error;
  }

  // Mail arriving from outside is never turned away for lack of room: the
  // sender could do nothing about it. What the user adds themself is.
  if (!options.delivery) {
    const limit = await ctx.mail.quotaOctets();
    if (limit !== null && (await usedOctets(ctx)) + raw.length > limit) {
      throw new SetFailure('overQuota', 'The account has no room for this');
    }
  }

  const threadId =
    (await findThread(ctx, parsed.metadata)) ??
    (suffix ? `th${suffix}` : generateId('th'));

  const value: EmailValue = {
    ...parsed.metadata,
    ...buildBodyLayout(parsed, blobId),
    layout: BODY_LAYOUT_VERSION,
    blobId,
    threadId,
    mailboxIds,
    keywords,
    size: raw.length,
    receivedAt: options.receivedAt ?? toUtcDate(new Date()),
  };

  await ctx.blobs.put(accountId, blobId, raw);
  try {
    await mutateThread(
      ctx,
      threadId,
      (emails) =>
        emails.some((email) => email.id === id)
          ? []
          : [{ kind: 'create', id, value, text: extractText(parsed) }],
      options.delivery ? () => deliveryOps(ctx) : undefined,
    );
  } catch (error) {
    // A concurrent import with the same key may have won; its blob must not be removed.
    const winner = await existing();
    if (winner) return winner;
    await ctx.blobs.delete(accountId, blobId);
    throw error;
  }
  if (options.delivery && ctx.mail.transport) {
    try {
      const outcome = await sendVacationReply(ctx, parsed, { keywords });
      ctx.mail.onAutoReply?.(outcome);
    } catch (error) {
      // The mail is delivered; a reply that could not be sent must not undo that.
      ctx.mail.onAutoReply?.('failed', error);
    }
  }
  return { id, blobId, threadId, size: raw.length };
}

const EmailImportSchema = z.strictObject({
  blobId: z.string(),
  mailboxIds: z.record(z.string(), z.literal(true)),
  keywords: z.record(z.string(), z.literal(true)).optional(),
  receivedAt: UTCDateSchema.optional(),
});

const EmailImportArgumentsSchema = z.strictObject({
  accountId: z.string(),
  ifInState: z.string().nullish(),
  emails: z.record(z.string(), z.record(z.string(), z.unknown())),
});

async function importOne(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  const parsed = EmailImportSchema.safeParse(input);
  if (!parsed.success) {
    // Every property at fault, not only the first.
    throw invalid(
      [
        ...new Set(
          parsed.error.issues.flatMap((issue) =>
            issue.code === 'unrecognized_keys'
              ? issue.keys
              : [String(issue.path[0] ?? '')],
          ),
        ),
      ].filter(Boolean),
      parsed.error.issues[0]?.message ?? 'Invalid import object',
    );
  }

  const raw = await readBlob(ctx, parsed.data.blobId);
  if (!raw) {
    // RFC 8621 §4.8: a blob id that is not found is an invalid property here.
    throw invalid(['blobId'], 'There is no blob with this id');
  }

  const imported = await importMessage(ctx, raw, {
    mailboxIds: parsed.data.mailboxIds,
    ...(parsed.data.keywords ? { keywords: parsed.data.keywords } : {}),
    ...(parsed.data.receivedAt ? { receivedAt: parsed.data.receivedAt } : {}),
  });
  return { ...imported };
}

interface EmailQueryResults {
  /** The ids found, in order. */
  ids: string[];
  /**
   * Whether an email's place in the results can depend on other emails of its
   * thread: with thread-wide keyword conditions, or when threads are collapsed.
   */
  dependsOnThread: boolean;
  /** Every email of the account by thread, when the query needed to know. */
  threadMembers?: Map<string, string[]>;
}

/** What an Email/query with these arguments finds now. */
async function queryEmails(
  ctx: MethodContext,
  args: {
    filter?: Record<string, unknown> | null | undefined;
    sort?: Comparator[] | null | undefined;
    collapseThreads?: boolean | undefined;
  },
  /** Whether the caller will ask which emails share a thread. */
  wantThreadMembers = false,
): Promise<EmailQueryResults> {
  const accountId = ctx.auth.accountId;
  const needsThreads =
    filterUses(args.filter, THREAD_KEYWORD_PROPERTIES) ||
    (args.sort ?? []).some((comparator) =>
      THREAD_KEYWORD_PROPERTIES.includes(comparator.property),
    );
  const mailboxes = requiredConditionValues(args.filter, 'inMailbox');
  const narrowTo =
    mailboxes.length === 1 && typeof mailboxes[0] === 'string'
      ? mailboxes[0]
      : undefined;

  const all =
    needsThreads || narrowTo === undefined
      ? await listAllEmails(ctx)
      : undefined;
  const candidates =
    narrowTo === undefined
      ? (all as EmailRecord[])
      : ((await ctx.store.list(accountId, EMAIL, {
          name: 'mailbox',
          value: narrowTo,
        })) as unknown as EmailRecord[]);

  const threads: ThreadIndex = new Map();
  if (needsThreads) {
    for (const record of all as EmailRecord[]) {
      const members = threads.get(record.value.threadId);
      if (members) members.push(record.value);
      else threads.set(record.value.threadId, [record.value]);
    }
  }

  const spec = emailQuerySpec(threads);
  // Checked before any text is loaded, so a bad filter costs nothing.
  if (args.filter) {
    validateFilter(args.filter, (condition) =>
      spec.validateCondition(condition),
    );
  }
  const texts = filterUses(args.filter, TEXT_CONDITIONS)
    ? await loadSearchText(
        ctx,
        candidates,
        narrowTo === undefined,
        parseMessage,
      )
    : undefined;

  let sorted = filterAndSort(
    candidates.map((record) => {
      const text = texts?.get(record.id);
      return {
        id: record.id,
        email: record.value,
        ...(text ? { text } : {}),
      };
    }),
    args.filter,
    args.sort,
    spec,
  );
  if (args.collapseThreads) {
    const seen = new Set<string>();
    sorted = sorted.filter(({ email }) => {
      if (seen.has(email.threadId)) return false;
      seen.add(email.threadId);
      return true;
    });
  }

  const dependsOnThread = needsThreads || args.collapseThreads === true;
  let threadMembers: Map<string, string[]> | undefined;
  if (wantThreadMembers && dependsOnThread) {
    threadMembers = new Map();
    for (const record of all ?? (await listAllEmails(ctx))) {
      const members = threadMembers.get(record.value.threadId);
      if (members) members.push(record.id);
      else threadMembers.set(record.value.threadId, [record.id]);
    }
  }
  return {
    ids: sorted.map((item) => item.id),
    dependsOnThread,
    ...(threadMembers ? { threadMembers } : {}),
  };
}

/*
 * The state of an email query is the state of the emails and of the threads
 * together: which emails are in a thread decides results too, and a thread
 * changes without any of its remaining emails changing when one is destroyed.
 */
async function emailQueryState(ctx: MethodContext): Promise<string> {
  const accountId = ctx.auth.accountId;
  return `${await ctx.store.getState(accountId, EMAIL)}.${await ctx.store.getState(accountId, THREAD)}`;
}

// ------------------------------------------------- Email/parse, Email/copy

/** RFC 8621 §4.9: what Email/parse returns when no properties are asked for. */
const DEFAULT_PARSE_PROPERTIES = [
  'messageId',
  'inReplyTo',
  'references',
  'sender',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'sentAt',
  'hasAttachment',
  'preview',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
];

const EmailParseArgumentsSchema = z.strictObject({
  accountId: z.string(),
  blobIds: z.array(z.string()),
  properties: z.array(z.string()).nullish(),
  bodyProperties: z.array(z.string()).nullish(),
  fetchTextBodyValues: z.boolean().optional(),
  fetchHTMLBodyValues: z.boolean().optional(),
  fetchAllBodyValues: z.boolean().optional(),
  maxBodyValueBytes: UnsignedIntSchema.optional(),
});

const EmailCopyArgumentsSchema = z.strictObject({
  fromAccountId: z.string(),
  ifFromInState: z.string().nullish(),
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())),
  onSuccessDestroyOriginal: z.boolean().optional(),
  destroyFromIfInState: z.string().nullish(),
});

// -------------------------------------------------------- SearchSnippet/get

const SearchSnippetArgumentsSchema = z.strictObject({
  accountId: z.string(),
  filter: z.record(z.string(), z.unknown()).nullish(),
  emailIds: z.array(z.string()),
});

/**
 * What to highlight for a filter: the text of the given conditions, wherever
 * they appear. Conditions under a NOT are left out, since they describe what
 * a match does not contain.
 */
function snippetSearch(
  filter: Record<string, unknown> | null | undefined,
  conditions: readonly string[],
): SearchQuery {
  const phrases: SearchQuery['phrases'] = [];
  const visit = (node: Record<string, unknown>) => {
    if (Array.isArray(node['conditions'])) {
      if (node['operator'] === 'NOT') return;
      for (const child of node['conditions']) {
        visit(child as Record<string, unknown>);
      }
      return;
    }
    for (const name of conditions) {
      if (typeof node[name] === 'string') {
        phrases.push(...parseSearch(node[name]).phrases);
      }
    }
  };
  if (filter) visit(filter);
  return { phrases };
}

// ------------------------------------------------------------------ methods

export const emailMethods: Record<string, MethodHandler> = {
  'Email/get': async (rawArgs, ctx) => {
    const args = parseArguments(EmailGetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const selection = selectWithHeaders(
      args.properties ? ['id', ...args.properties] : DEFAULT_EMAIL_PROPERTIES,
      EMAIL_PROPERTIES,
      'Email',
    );
    const bodySelection = selectWithHeaders(
      args.bodyProperties ?? DEFAULT_BODY_PROPERTIES,
      BODY_PROPERTIES,
      'body part',
    );

    const { state, records, notFound } = await loadForGet(ctx, EMAIL, args.ids);
    const list: Record<string, unknown>[] = [];
    for (const record of records as unknown as EmailRecord[]) {
      list.push(
        await toEmailObject(ctx, record, args, selection, bodySelection),
      );
    }
    return { accountId, state, list, notFound };
  },

  'Email/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, EMAIL, rawArgs)),
  }),

  'Email/query': async (rawArgs, ctx) => {
    const args = parseArguments(EmailQueryArgumentsSchema, rawArgs);
    requireAccount(ctx, args.accountId);
    // Read first: a client may then see results newer than the state, never older.
    const state = await emailQueryState(ctx);
    const { ids } = await queryEmails(ctx, args);
    return { ...paginate(ctx, ids, args, state) };
  },

  'SearchSnippet/get': async (rawArgs, ctx) => {
    const args = parseArguments(SearchSnippetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const emailIds = [...new Set(args.emailIds)];
    if (emailIds.length > ctx.limits.maxObjectsInGet) {
      throw new MethodError(
        'requestTooLarge',
        `Snippets for at most ${ctx.limits.maxObjectsInGet} emails may be requested at once`,
      );
    }
    if (args.filter) {
      const spec = emailQuerySpec(new Map());
      validateFilter(args.filter, (condition) =>
        spec.validateCondition(condition),
      );
    }
    const inSubject = snippetSearch(args.filter, ['text', 'subject']);
    const inBody = snippetSearch(args.filter, ['text', 'body']);

    const records = (await ctx.store.get(
      accountId,
      EMAIL,
      emailIds,
    )) as unknown as EmailRecord[];
    const byId = new Map(records.map((record) => [record.id, record]));
    const previews = new Map<string, string | null>();
    if (inBody.phrases.length > 0) {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, records.length) }, async () => {
          while (next < records.length) {
            const record = records[next++] as EmailRecord;
            const raw = await ctx.blobs.get(accountId, record.value.blobId);
            if (!raw) continue;
            try {
              previews.set(
                record.id,
                highlight(
                  bodyText(await parseMessage(raw)),
                  inBody,
                  MAX_SNIPPET_BYTES,
                ),
              );
            } catch (error) {
              if (!(error instanceof InvalidMessageError)) throw error;
            }
          }
        }),
      );
    }

    const notFound = emailIds.filter((id) => !byId.has(id));
    return {
      accountId,
      list: emailIds.flatMap((id) => {
        const record = byId.get(id);
        if (!record) return [];
        return [
          {
            emailId: id,
            subject:
              inSubject.phrases.length > 0
                ? highlight(record.value.subject ?? '', inSubject)
                : null,
            preview: previews.get(id) ?? null,
          },
        ];
      }),
      notFound: notFound.length > 0 ? notFound : null,
    };
  },

  'Email/parse': async (rawArgs, ctx) => {
    const args = parseArguments(EmailParseArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const blobIds = [...new Set(args.blobIds)];
    if (blobIds.length > ctx.limits.maxObjectsInGet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInGet} blobs may be parsed at once`,
      );
    }
    const selection = selectWithHeaders(
      args.properties ?? DEFAULT_PARSE_PROPERTIES,
      EMAIL_PROPERTIES,
      'Email',
    );
    const bodySelection = selectWithHeaders(
      args.bodyProperties ?? DEFAULT_BODY_PROPERTIES,
      BODY_PROPERTIES,
      'body part',
    );

    const parsedEmails: Record<string, unknown> = {};
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
      let message: ParsedMessage;
      try {
        message = await parseMessage(raw);
      } catch (error) {
        if (!(error instanceof InvalidMessageError)) throw error;
        notParsable.push(blobId);
        continue;
      }
      // An email that is not in the mail store: it has no id, mailboxes,
      // keywords or time of arrival, and is in no thread.
      const value = {
        ...message.metadata,
        ...buildBodyLayout(message, blobId),
        layout: BODY_LAYOUT_VERSION,
        blobId,
        threadId: null,
        mailboxIds: null,
        keywords: null,
        size: raw.length,
        receivedAt: null,
      } as unknown as EmailValue;
      parsedEmails[blobId] = await toEmailObject(
        ctx,
        { id: null as unknown as string, version: 0, value },
        args,
        selection,
        bodySelection,
        message,
      );
    }
    const orNull = <T>(list: T[]): T[] | null =>
      list.length > 0 ? list : null;
    return {
      accountId,
      parsed: Object.keys(parsedEmails).length > 0 ? parsedEmails : null,
      notParsable: orNull(notParsable),
      notFound: orNull(notFound),
    };
  },

  'Email/copy': async (rawArgs, ctx) => {
    const args = parseArguments(EmailCopyArgumentsSchema, rawArgs);
    const { from, to } = requireCopyAccounts(
      ctx,
      args.fromAccountId,
      args.accountId,
    );
    // Checked before anything is copied: a move must not end as a copy.
    if (args.onSuccessDestroyOriginal && from.isReadOnly) {
      throw new MethodError(
        'accountReadOnly',
        'The originals cannot be destroyed: their account is read-only',
      );
    }
    const create = Object.entries(args.create);
    if (create.length > ctx.limits.maxObjectsInSet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInSet} emails may be copied in one call`,
      );
    }
    const oldState = await to.store.getState(args.accountId, EMAIL);
    if (
      (args.ifInState !== null &&
        args.ifInState !== undefined &&
        args.ifInState !== oldState) ||
      (args.ifFromInState !== null &&
        args.ifFromInState !== undefined &&
        args.ifFromInState !==
          (await from.store.getState(args.fromAccountId, EMAIL)))
    ) {
      throw new MethodError('stateMismatch');
    }

    const created: Record<string, ImportedEmail> = {};
    const notCreated: Record<string, SetError> = {};
    const copiedFrom: string[] = [];
    for (const [creationId, input] of create) {
      try {
        const unknown = Object.keys(input).filter(
          (property) =>
            !['id', 'mailboxIds', 'keywords', 'receivedAt'].includes(property),
        );
        if (unknown.length > 0) {
          throw invalid(unknown, 'These properties cannot be set on a copy');
        }
        if (typeof input['id'] !== 'string') {
          throw invalid(['id'], 'id must be the id of the email to copy');
        }
        if (
          input['receivedAt'] !== undefined &&
          !UTCDateSchema.safeParse(input['receivedAt']).success
        ) {
          throw invalid(['receivedAt'], 'receivedAt must be a UTC date');
        }
        const source = await getEmail(from, input['id']);
        const raw = source
          ? await from.blobs.get(args.fromAccountId, source.value.blobId)
          : null;
        if (!source || !raw) throw new SetFailure('notFound');

        // The copy is the same message; what is not given comes from the original.
        created[creationId] = await importMessage(to, raw, {
          mailboxIds: (input['mailboxIds'] ?? {}) as Record<string, true>,
          keywords: (input['keywords'] ?? source.value.keywords) as Record<
            string,
            true
          >,
          receivedAt:
            (input['receivedAt'] as string | undefined) ??
            source.value.receivedAt,
        });
        to.createdIds.set(creationId, created[creationId].id);
        copiedFrom.push(source.id);
      } catch (error) {
        if (!(error instanceof SetFailure)) throw error;
        notCreated[creationId] = error.error;
      }
    }

    if (args.onSuccessDestroyOriginal && copiedFrom.length > 0) {
      // Reported as the Email/set it is, after the copy's own response.
      ctx.extraResponses.push([
        'Email/set',
        {
          ...(await runEmailSet(from, {
            accountId: args.fromAccountId,
            ifInState: args.destroyFromIfInState,
            destroy: copiedFrom,
          })),
        },
      ]);
    }

    return {
      fromAccountId: args.fromAccountId,
      accountId: args.accountId,
      oldState,
      newState: await to.store.getState(args.accountId, EMAIL),
      created: Object.keys(created).length > 0 ? created : null,
      notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    };
  },

  'Email/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(
      QueryChangesArgumentsSchema.extend({
        collapseThreads: z.boolean().optional(),
      }),
      rawArgs,
    );
    requireAccount(ctx, args.accountId);
    const [sinceEmails, sinceThreads, ...rest] =
      args.sinceQueryState.split('.');
    if (
      sinceEmails === undefined ||
      sinceThreads === undefined ||
      rest.length
    ) {
      throw new MethodError('cannotCalculateChanges');
    }
    const state = await emailQueryState(ctx);
    const changes = await changesSince(ctx, EMAIL, sinceEmails);
    const threadChanges = await changesSince(ctx, THREAD, sinceThreads);
    const { ids, dependsOnThread, threadMembers } = await queryEmails(
      ctx,
      args,
      true,
    );

    // Where threads matter, a change to one email may move the others of its thread.
    const alsoChanged = new Set<string>();
    if (dependsOnThread && threadMembers) {
      const changedEmails = new Set(changes.map((entry) => entry.id));
      const changedThreads = new Set(threadChanges.map((entry) => entry.id));
      for (const [threadId, members] of threadMembers) {
        if (
          changedThreads.has(threadId) ||
          members.some((id) => changedEmails.has(id))
        ) {
          for (const id of members) alsoChanged.add(id);
        }
      }
    }
    return { ...queryChanges(ctx, ids, changes, alsoChanged, args, state) };
  },

  'Email/set': async (rawArgs, ctx) => {
    const args = parseArguments(SetArgumentsSchema, rawArgs);
    return { ...(await standardSet(ctx, emailSetSpec, args)) };
  },

  'Email/import': async (rawArgs, ctx) => {
    const args = parseArguments(EmailImportArgumentsSchema, rawArgs);
    const result = await standardSet(
      ctx,
      { type: EMAIL, create: importOne },
      {
        accountId: args.accountId,
        ifInState: args.ifInState,
        create: args.emails,
      },
    );
    return {
      accountId: result.accountId,
      oldState: result.oldState,
      newState: result.newState,
      created: result.created,
      notCreated: result.notCreated,
    };
  },
};
