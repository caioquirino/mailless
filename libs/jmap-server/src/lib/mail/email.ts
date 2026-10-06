import {
  applyPatch,
  DEFAULT_BODY_PROPERTIES,
  DEFAULT_EMAIL_PROPERTIES,
  GetArgumentsSchema,
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
} from '@mailless/jmap-core';
import { z } from 'zod';
import {
  generateId,
  parseArguments,
  requireAccount,
  toUtcDate,
  type MethodContext,
  type MethodHandler,
} from '../context.js';
import { standardChanges, toChangesResponse } from '../standard/changes.js';
import { loadForGet } from '../standard/get.js';
import {
  compareStrings,
  filterAndSort,
  paginate,
  requiredConditionValues,
  type CompareFn,
  type QuerySpec,
} from '../standard/query.js';
import {
  resolveCreationReference,
  standardSet,
  type SetSpec,
} from '../standard/set.js';
import { destroyEmail, getEmail, mutateThread } from './email-store.js';
import {
  headerAsText,
  headerValues,
  parseHeaderProperty,
  readHeaderProperty,
  type HeaderProperty,
} from './headers.js';
import {
  buildBodyLayout,
  InvalidMessageError,
  parseMessage,
  splitPartBlobId,
} from './mime.js';
import {
  baseSubject,
  EMAIL,
  isValidKeyword,
  MAILBOX,
  type EmailRecord,
  type EmailValue,
  type StoredBodyPart,
} from './model.js';

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

/** Reads a blob by id: an uploaded blob, a stored message, or one decoded part of a stored message. */
export async function readBlob(
  ctx: MethodContext,
  blobId: string,
): Promise<Uint8Array | null> {
  const accountId = ctx.auth.accountId;
  const direct = await ctx.blobs.get(accountId, blobId);
  if (direct) return direct;

  const partReference = splitPartBlobId(blobId);
  if (!partReference) return null;
  const message = await ctx.blobs.get(accountId, partReference.messageBlobId);
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
    if (header) selection.headers.set(property, header);
    else if (valid.includes(property)) selection.plain.push(property);
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
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const property of selection.plain) {
    if (property === 'headers') result[property] = [];
    else if (property === 'language' || property === 'location') {
      result[property] = null;
    } else if (property === 'subParts') {
      result[property] =
        part.subParts?.map((child) => projectPart(child, selection)) ?? null;
    } else {
      result[property] = part[property as keyof StoredBodyPart];
    }
  }
  // Part-level headers are not kept, so header properties on parts are always empty.
  for (const [property, header] of selection.headers) {
    result[property] = header.all ? [] : null;
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
): Promise<Record<string, unknown>> {
  if (partIds.size === 0) return {};
  const raw = await ctx.blobs.get(ctx.auth.accountId, email.blobId);
  if (!raw) return {};

  const parsed = await parseMessage(raw);
  const values: Record<string, unknown> = {};
  for (const part of parsed.parts) {
    if (!partIds.has(part.partId)) continue;
    values[part.partId] = {
      ...truncateUtf8(decoder.decode(part.data), maxBytes),
      isEncodingProblem: false,
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
): Promise<Record<string, unknown>> {
  const email = record.value;
  const leaves = leafParts(email.bodyStructure);
  const byPartId = new Map(leaves.map((part) => [part.partId, part]));
  const partList = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const part = byPartId.get(id);
      return part ? [projectPart(part, bodySelection)] : [];
    });

  const result: Record<string, unknown> = {};
  for (const property of selection.plain) {
    switch (property) {
      case 'id':
        result[property] = record.id;
        break;
      case 'bodyStructure':
        result[property] = projectPart(email.bodyStructure, bodySelection);
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
        );
        break;
      }
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
  from: isString,
  to: isString,
  cc: isString,
  bcc: isString,
  subject: isString,
  header: (value) =>
    isStringArray(value) &&
    ((value as string[]).length === 1 || (value as string[]).length === 2),
};

/** Conditions that need message bodies, which no search backend indexes yet. */
const UNSUPPORTED_CONDITIONS = ['text', 'body'];

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
  return {
    validateCondition(condition) {
      for (const [key, value] of Object.entries(condition)) {
        if (UNSUPPORTED_CONDITIONS.includes(key)) {
          throw new MethodError(
            'unsupportedFilter',
            `Filtering on "${key}" needs full-text search, which is not available`,
          );
        }
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

    matches({ email }, condition) {
      for (const [key, value] of Object.entries(condition)) {
        let ok: boolean;
        switch (key) {
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
            compareStrings(sortKey(a.email.from), sortKey(b.email.from));
        case 'to':
          return (a, b) =>
            compareStrings(sortKey(a.email.to), sortKey(b.email.to));
        case 'subject':
          return (a, b) =>
            compareStrings(
              baseSubject(a.email.subject),
              baseSubject(b.email.subject),
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

const emailSetSpec: SetSpec = {
  type: EMAIL,
  create: async () => {
    throw new SetFailure(
      'forbidden',
      'Creating emails with Email/set is not supported yet; upload the message and use Email/import',
    );
  },
  update: updateEmail,
  destroy: async (ctx, id) => {
    if (!(await destroyEmail(ctx, id))) throw new SetFailure('notFound');
  },
};

// ------------------------------------------------------------- Email/import

export interface ImportOptions {
  /** Mailbox ids; keys may be `#creationId` references within a request. */
  mailboxIds: Record<string, true>;
  keywords?: Record<string, true>;
  receivedAt?: string;
}

export interface ImportedEmail {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
}

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
  ];
  for (const key of keys) {
    const related = (await ctx.store.list(ctx.auth.accountId, EMAIL, {
      name: 'threadKey',
      value: key,
    })) as unknown as EmailRecord[];
    const match = related.find(
      (record) => baseSubject(record.value.subject) === subject,
    );
    if (match) return match.value.threadId;
  }
  return undefined;
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
  const mailboxIds = await normaliseMailboxIds(ctx, options.mailboxIds);
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

  const id = generateId('em');
  const blobId = generateId('bm');
  const threadId = (await findThread(ctx, parsed.metadata)) ?? generateId('th');

  const value: EmailValue = {
    ...parsed.metadata,
    ...buildBodyLayout(parsed, blobId),
    blobId,
    threadId,
    mailboxIds,
    keywords,
    size: raw.length,
    receivedAt: options.receivedAt ?? toUtcDate(new Date()),
  };

  await ctx.blobs.put(accountId, blobId, raw);
  try {
    await mutateThread(ctx, threadId, () => [{ kind: 'create', id, value }]);
  } catch (error) {
    await ctx.blobs.delete(accountId, blobId);
    throw error;
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
    const issue = parsed.error.issues[0];
    throw invalid(
      [String(issue?.path[0] ?? '')].filter(Boolean),
      issue?.message ?? 'Invalid import object',
    );
  }

  const raw = await readBlob(ctx, parsed.data.blobId);
  if (!raw) {
    throw new SetFailure('blobNotFound', undefined, {
      notFound: [parsed.data.blobId],
    });
  }

  const imported = await importMessage(ctx, raw, {
    mailboxIds: parsed.data.mailboxIds,
    ...(parsed.data.keywords ? { keywords: parsed.data.keywords } : {}),
    ...(parsed.data.receivedAt ? { receivedAt: parsed.data.receivedAt } : {}),
  });
  return { ...imported };
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
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, EMAIL);

    const needsThreads = THREAD_KEYWORD_PROPERTIES.some(
      (property) =>
        JSON.stringify(args.filter ?? {}).includes(`"${property}"`) ||
        (args.sort ?? []).some(
          (comparator) => comparator.property === property,
        ),
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

    let sorted = filterAndSort(
      candidates.map((record) => ({ id: record.id, email: record.value })),
      args.filter,
      args.sort,
      emailQuerySpec(threads),
    );
    if (args.collapseThreads) {
      const seen = new Set<string>();
      sorted = sorted.filter(({ email }) => {
        if (seen.has(email.threadId)) return false;
        seen.add(email.threadId);
        return true;
      });
    }

    return {
      ...paginate(
        ctx,
        sorted.map((item) => item.id),
        args,
        state,
      ),
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
    throw new MethodError('cannotCalculateChanges');
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
