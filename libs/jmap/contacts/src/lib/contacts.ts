import {
  applyPatch,
  CAPABILITY_CONTACTS,
  GetArgumentsSchema,
  MethodError,
  PatchError,
  QueryArgumentsSchema,
  QueryChangesArgumentsSchema,
  SetArgumentsSchema,
  SetFailure,
  type Comparator,
  type SetError,
} from '@mailless/jmap-core';
import { z } from 'zod';
import { cardProblems, isPlainObject } from './jscontact.js';

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
  requireCopyAccounts,
  requiredConditionValues,
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
  type SetArgumentsLike,
  type SetSpec,
  type StoredRecord,
  type WriteOp,
} from '@mailless/jmap-engine';
export { CAPABILITY_CONTACTS };

/*
 * Contacts (RFC 9610): address books, and the cards in them. A card is a
 * JSContact Card (RFC 9553) stored as the client gave it, with an id and the
 * address books it is in.
 */

export const ADDRESS_BOOK = 'AddressBook';
export const CONTACT_CARD = 'ContactCard';
/** One record per account: which address book is the default. */
const SETTINGS = 'ContactSettings';
const SETTINGS_ID = 'settings';

/** Cards are stored whole, so a card has to fit in one record of any backend. */
export const MAX_CARD_OCTETS = 256 * 1024;
/** How many cards one commit changes when an address book is emptied. */
const CARDS_PER_COMMIT = 10;

const invalid = (properties: string[], description: string): SetFailure =>
  new SetFailure('invalidProperties', description, { properties });

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------ address books

interface AddressBookValue {
  name: string;
  description: string | null;
  sortOrder: number;
  isSubscribed: boolean;
}

const BOOK_PROPERTIES = [
  'id',
  'name',
  'description',
  'sortOrder',
  'isDefault',
  'isSubscribed',
  'shareWith',
  'myRights',
];

const encoder = new TextEncoder();

async function defaultBookId(ctx: MethodContext): Promise<string | null> {
  const [settings] = await ctx.store.get(ctx.auth.accountId, SETTINGS, [
    SETTINGS_ID,
  ]);
  return (settings?.value['defaultAddressBookId'] as string | null) ?? null;
}

function describeBook(
  ctx: MethodContext,
  id: string,
  value: AddressBookValue,
  defaultId: string | null,
): Record<string, unknown> {
  return {
    id,
    name: value.name,
    description: value.description,
    sortOrder: value.sortOrder,
    isDefault: id === defaultId,
    isSubscribed: value.isSubscribed,
    // Access is given to a whole account, not to one address book of it.
    shareWith: null,
    myRights: {
      mayRead: true,
      mayWrite: !ctx.isReadOnly,
      mayShare: false,
      mayDelete: !ctx.isReadOnly,
    },
  };
}

/** Takes what a client may set from a whole address book, or says what is wrong with it. */
function bookValue(book: Record<string, unknown>): AddressBookValue {
  const problems: string[] = [];
  const { name, description, sortOrder, isSubscribed } = book;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    encoder.encode(name).length > 255
  ) {
    problems.push('name');
  }
  if (description !== null && typeof description !== 'string') {
    problems.push('description');
  }
  if (!Number.isSafeInteger(sortOrder) || (sortOrder as number) < 0) {
    problems.push('sortOrder');
  }
  if (typeof isSubscribed !== 'boolean') problems.push('isSubscribed');
  for (const property of Object.keys(book)) {
    if (!BOOK_PROPERTIES.includes(property)) problems.push(property);
  }
  if (problems.length > 0) {
    throw invalid(problems, 'These properties are missing or not valid');
  }
  return { name, description, sortOrder, isSubscribed } as AddressBookValue;
}

/**
 * What the server decides may be sent back as it is (RFC 8620 §5.3), and
 * nothing else. Sharing is asked for as a change, so it is refused as one.
 */
function requireServerSet(
  given: Record<string, unknown>,
  actual: Record<string, unknown>,
): void {
  const { shareWith } = given;
  if (
    shareWith !== null &&
    !(isPlainObject(shareWith) && Object.keys(shareWith).length === 0)
  ) {
    throw new SetFailure(
      'forbidden',
      'An address book cannot be shared on its own; the whole account is shared',
    );
  }
  const changed = ['id', 'isDefault', 'myRights'].filter(
    (property) => !same(given[property], actual[property]),
  );
  if (changed.length > 0) {
    throw invalid(changed, 'These properties are set by the server');
  }
}

async function createBook(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  const id = generateId('ab');
  const defaults: AddressBookValue = {
    name: '',
    description: null,
    sortOrder: 0,
    isSubscribed: true,
  };
  const book = { ...describeBook(ctx, id, defaults, null), ...input, id };
  if (input['id'] !== undefined)
    throw invalid(['id'], 'The server sets the id');
  requireServerSet(book, describeBook(ctx, id, defaults, null));
  const value = bookValue(book);
  await commit(ctx, [
    { kind: 'create', type: ADDRESS_BOOK, id, value: { ...value } },
  ]);
  // The client is told what it did not say itself.
  const described = describeBook(ctx, id, value, null);
  return {
    id,
    ...Object.fromEntries(
      Object.entries(described).filter(
        ([property]) => input[property] === undefined,
      ),
    ),
  };
}

async function updateBook(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<null> {
  const [record] = await ctx.store.get(ctx.auth.accountId, ADDRESS_BOOK, [id]);
  if (!record) throw new SetFailure('notFound');
  const current = describeBook(
    ctx,
    id,
    record.value as unknown as AddressBookValue,
    await defaultBookId(ctx),
  );
  let next: Record<string, unknown>;
  try {
    next = applyPatch(current, patch);
  } catch (error) {
    if (error instanceof PatchError) {
      throw new SetFailure('invalidPatch', error.message);
    }
    throw error;
  }
  requireServerSet(next, current);
  const value = bookValue(next);
  const changedProperties = Object.keys(value).filter(
    (property) => !same(next[property], current[property]),
  );
  if (changedProperties.length === 0) return null;
  await commit(ctx, [
    {
      kind: 'update',
      type: ADDRESS_BOOK,
      id,
      value: { ...value },
      expectedVersion: record.version,
      changedProperties,
    },
  ]);
  return null;
}

const cardsIn = (ctx: MethodContext, addressBookId: string) =>
  ctx.store.list(ctx.auth.accountId, CONTACT_CARD, {
    name: 'addressBook',
    value: addressBookId,
  });

async function destroyBook(
  ctx: MethodContext,
  id: string,
  removeContents: boolean,
): Promise<void> {
  const accountId = ctx.auth.accountId;
  const [record] = await ctx.store.get(accountId, ADDRESS_BOOK, [id]);
  if (!record) throw new SetFailure('notFound');
  const cards = await cardsIn(ctx, id);
  if (cards.length > 0 && !removeContents) {
    throw new SetFailure(
      'addressBookHasContents',
      'The address book still has cards in it',
    );
  }
  // A card that is in another address book as well only leaves this one.
  const ops = cards.map((card): WriteOp => {
    const remaining = Object.keys(
      card.value['addressBookIds'] as Record<string, true>,
    ).filter((bookId) => bookId !== id);
    if (remaining.length === 0) {
      return {
        kind: 'destroy',
        type: CONTACT_CARD,
        id: card.id,
        expectedVersion: card.version,
      };
    }
    const value = {
      ...card.value,
      addressBookIds: Object.fromEntries(
        remaining.map((bookId) => [bookId, true]),
      ),
    };
    return {
      kind: 'update',
      type: CONTACT_CARD,
      id: card.id,
      value,
      expectedVersion: card.version,
      indexes: cardIndexes(value),
      changedProperties: ['addressBookIds'],
    };
  });
  for (let start = 0; start < ops.length; start += CARDS_PER_COMMIT) {
    await commit(ctx, ops.slice(start, start + CARDS_PER_COMMIT));
  }

  const [settings] = await ctx.store.get(accountId, SETTINGS, [SETTINGS_ID]);
  await commit(ctx, [
    {
      kind: 'destroy',
      type: ADDRESS_BOOK,
      id,
      expectedVersion: record.version,
    },
    // Nothing takes the place of a default that is gone; the client may name another.
    ...(settings?.value['defaultAddressBookId'] === id
      ? [
          {
            kind: 'update',
            type: SETTINGS,
            id: SETTINGS_ID,
            value: { defaultAddressBookId: null },
            expectedVersion: settings.version,
          } as const,
        ]
      : []),
  ]);
}

/**
 * Makes an address book the default. Returns what changed for which address
 * book, or null when nothing did: it is the default already, or does not exist.
 */
async function setDefaultBook(
  ctx: MethodContext,
  id: string,
): Promise<Record<string, { isDefault: boolean }> | null> {
  const accountId = ctx.auth.accountId;
  return retryOnConflict(async () => {
    const [settings] = await ctx.store.get(accountId, SETTINGS, [SETTINGS_ID]);
    const previous =
      (settings?.value['defaultAddressBookId'] as string | null) ?? null;
    if (previous === id) return null;
    const books = await ctx.store.get(accountId, ADDRESS_BOOK, [
      id,
      ...(previous === null ? [] : [previous]),
    ]);
    if (!books.some((book) => book.id === id)) return null;
    const value = { defaultAddressBookId: id };
    await commit(ctx, [
      settings
        ? {
            kind: 'update',
            type: SETTINGS,
            id: SETTINGS_ID,
            value,
            expectedVersion: settings.version,
          }
        : { kind: 'create', type: SETTINGS, id: SETTINGS_ID, value },
      // Written as they are, so that both are reported as changed.
      ...books.map((book): WriteOp => ({
        kind: 'update',
        type: ADDRESS_BOOK,
        id: book.id,
        value: book.value,
        expectedVersion: book.version,
        changedProperties: ['isDefault'],
      })),
    ]);
    return Object.fromEntries(
      books.map((book) => [book.id, { isDefault: book.id === id }]),
    );
  });
}

/** Gives an account that has no address book one to start with, as its default. */
export async function provisionAddressBooks(ctx: MethodContext): Promise<void> {
  const accountId = ctx.auth.accountId;
  if ((await ctx.store.list(accountId, ADDRESS_BOOK)).length > 0) return;
  const { id } = await createBook(ctx, { name: 'Contacts' });
  await setDefaultBook(ctx, id);
}

const AddressBookSetArgumentsSchema = SetArgumentsSchema.extend({
  onDestroyRemoveContents: z.boolean().optional(),
  onSuccessSetIsDefault: z.string().nullish(),
});

// -------------------------------------------------------------------- cards

type Card = { id: string } & Record<string, unknown>;

const toCard = (record: StoredRecord): Card => ({
  id: record.id,
  ...record.value,
});

/** A uid may be any text of any length, so it is found by a digest and then compared. */
function cardIndexes(value: Record<string, unknown>): Record<string, string[]> {
  return {
    addressBook: Object.keys(value['addressBookIds'] as object),
    uid: [fingerprint(String(value['uid']))],
  };
}

async function findByUid(
  ctx: MethodContext,
  uid: string,
): Promise<StoredRecord | undefined> {
  const records = await ctx.store.list(ctx.auth.accountId, CONTACT_CARD, {
    name: 'uid',
    value: fingerprint(uid),
  });
  return records.find((record) => record.value['uid'] === uid);
}

const IMAGE_TYPES: Array<
  [type: string, matches: (data: Uint8Array) => boolean]
> = [
  ['image/png', (data) => startsWith(data, [0x89, 0x50, 0x4e, 0x47])],
  ['image/jpeg', (data) => startsWith(data, [0xff, 0xd8, 0xff])],
  ['image/gif', (data) => startsWith(data, [0x47, 0x49, 0x46, 0x38])],
  [
    'image/webp',
    (data) =>
      startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  ],
  ['image/bmp', (data) => startsWith(data, [0x42, 0x4d])],
  [
    'image/avif',
    (data) => /^ftyp(avif|avis)/.test(ascii(data.subarray(4, 12))),
  ],
  [
    'image/heic',
    (data) => /^ftyp(heic|heix|mif1)/.test(ascii(data.subarray(4, 12))),
  ],
  ['image/svg+xml', (data) => /<svg[\s>]/i.test(ascii(data.subarray(0, 1024)))],
];

function startsWith(data: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte);
}

function ascii(data: Uint8Array): string {
  return String.fromCharCode(...data);
}

/** The media type of an image, told from its content; undefined for anything else. */
export function imageType(data: Uint8Array): string | undefined {
  return IMAGE_TYPES.find(([, matches]) => matches(data))?.[0];
}

/**
 * Checks the files a card refers to by blob id (RFC 9610 §3) and fills in
 * their media type. `blobs` is the account the blobs are in.
 */
async function checkMedia(
  blobs: MethodContext,
  card: Record<string, unknown>,
): Promise<void> {
  if (!isPlainObject(card['media'])) return;
  const media: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(card['media'])) {
    const item = { ...(entry as Record<string, unknown>) };
    media[key] = item;
    const path = `media/${key}`;
    const { blobId, uri } = item;
    if ((blobId === undefined) === (uri === undefined)) {
      throw invalid([path], 'Media has either a uri or a blobId');
    }
    if (blobId === undefined) continue;
    const data = await blobs.readBlob(blobId as string);
    if (!data) {
      throw new SetFailure('blobNotFound', 'A file of the card was not found', {
        notFound: [blobId],
      });
    }
    const type = imageType(data);
    if (item['kind'] === 'photo' && !type) {
      throw invalid([path], 'A photo must be an image of a known type');
    }
    item['mediaType'] ??= type ?? 'application/octet-stream';
    // The card relies on the file from now on: an upload that would have been let go stays.
    await blobs.blobs.keep(blobs.auth.accountId, blobId as string);
  }
  card['media'] = media;
}

/** Everything a card must satisfy before it is stored. `id` is null for a new card. */
async function checkCard(
  ctx: MethodContext,
  id: string | null,
  card: Record<string, unknown>,
): Promise<void> {
  const problems = cardProblems(card);
  if (card['id'] !== undefined) problems.push('id');
  if (problems.length > 0) {
    throw invalid(problems, 'These properties are missing or not valid');
  }
  const books = card['addressBookIds'];
  const bookIds = isPlainObject(books) ? Object.keys(books) : [];
  if (
    bookIds.length === 0 ||
    Object.values(books as object).some((value) => value !== true) ||
    (await ctx.store.get(ctx.auth.accountId, ADDRESS_BOOK, bookIds)).length !==
      bookIds.length
  ) {
    throw invalid(
      ['addressBookIds'],
      'A card is in at least one address book, and only in ones that exist',
    );
  }
  const twin = await findByUid(ctx, card['uid'] as string);
  if (twin && twin.id !== id) {
    throw invalid(['uid'], 'Another card of this account has the same uid');
  }
  if (encoder.encode(JSON.stringify(card)).length > MAX_CARD_OCTETS) {
    throw new SetFailure(
      'tooLarge',
      `A card may take up ${MAX_CARD_OCTETS} octets at most; upload large files and refer to them by blobId`,
    );
  }
}

/** Replaces `#creationId` keys of an id set by the ids they stand for. */
function resolveBookIds(ctx: MethodContext, books: unknown): unknown {
  if (!isPlainObject(books)) return books;
  return Object.fromEntries(
    Object.entries(books).map(([id, value]) => [
      resolveCreationReference(ctx, id) ?? id,
      value,
    ]),
  );
}

async function storeNewCard(
  ctx: MethodContext,
  card: Record<string, unknown>,
): Promise<string> {
  await checkCard(ctx, null, card);
  const id = generateId('cc');
  await commit(ctx, [
    {
      kind: 'create',
      type: CONTACT_CARD,
      id,
      value: card,
      indexes: cardIndexes(card),
    },
  ]);
  return id;
}

async function createCard(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<Card> {
  const now = toUtcDate(new Date());
  // What a card must have and the client left out is the server's to give.
  const serverSet: Record<string, unknown> = {};
  const defaults = {
    '@type': 'Card',
    version: '1.0',
    uid: `urn:uuid:${crypto.randomUUID()}`,
    created: now,
    updated: now,
  };
  for (const [property, value] of Object.entries(defaults)) {
    if (input[property] === undefined) serverSet[property] = value;
  }
  const card = {
    ...input,
    ...serverSet,
    addressBookIds: resolveBookIds(ctx, input['addressBookIds']),
  };
  await checkMedia(ctx, card);
  const id = await storeNewCard(ctx, card);
  return { id, ...serverSet };
}

async function updateCard(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const [record] = await ctx.store.get(ctx.auth.accountId, CONTACT_CARD, [id]);
  if (!record) throw new SetFailure('notFound');
  const resolved = Object.fromEntries(
    Object.entries(patch).map(([path, value]) => {
      const [property, key, ...rest] = path.split('/');
      if (property !== 'addressBookIds') return [path, value];
      if (key === undefined) return [path, resolveBookIds(ctx, value)];
      const bookId = resolveCreationReference(ctx, key) ?? key;
      return [[property, bookId, ...rest].join('/'), value];
    }),
  );
  if (Object.keys(resolved).some((path) => path.split('/')[0] === 'id')) {
    throw invalid(['id'], 'The id of a card cannot be changed');
  }
  let next: Record<string, unknown>;
  try {
    next = applyPatch(record.value, resolved);
  } catch (error) {
    if (error instanceof PatchError) {
      throw new SetFailure('invalidPatch', error.message);
    }
    throw error;
  }
  // A card has no property whose value is null: to set one to null is to remove it.
  for (const [property, value] of Object.entries(next)) {
    if (value === null) delete next[property];
  }
  const changedProperties = [
    ...new Set(Object.keys(resolved).map((path) => path.split('/')[0] ?? path)),
  ].filter((property) => !same(next[property], record.value[property]));
  if (changedProperties.length === 0) return null;

  const serverSet: Record<string, unknown> = {};
  if (!changedProperties.includes('updated')) {
    serverSet['updated'] = next['updated'] = toUtcDate(new Date());
    changedProperties.push('updated');
  }
  if (changedProperties.includes('media')) await checkMedia(ctx, next);
  await checkCard(ctx, id, next);
  await commit(ctx, [
    {
      kind: 'update',
      type: CONTACT_CARD,
      id,
      value: next,
      expectedVersion: record.version,
      indexes: cardIndexes(next),
      changedProperties,
    },
  ]);
  return serverSet;
}

async function destroyCard(ctx: MethodContext, id: string): Promise<void> {
  const [record] = await ctx.store.get(ctx.auth.accountId, CONTACT_CARD, [id]);
  if (!record) throw new SetFailure('notFound');
  await commit(ctx, [
    {
      kind: 'destroy',
      type: CONTACT_CARD,
      id,
      expectedVersion: record.version,
    },
  ]);
}

const cardSetSpec: SetSpec = {
  type: CONTACT_CARD,
  create: createCard,
  update: updateCard,
  destroy: destroyCard,
};

const runCardSet = (ctx: MethodContext, args: SetArgumentsLike) =>
  standardSet(ctx, cardSetSpec, args);

// ------------------------------------------------------------------ queries

/**
 * What a filter's text asks for (RFC 9610 §3.3.1): words that must all be
 * there, in any order, and quoted phrases that must be there as they are.
 */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    const phrase = match[1] ?? match[2];
    const term =
      phrase === undefined
        ? (match[3] as string)
        : phrase.replace(/\\(["'\\])/g, '$1');
    if (term.length > 0) terms.push(term.toLowerCase());
  }
  return terms;
}

/** Whether every term is somewhere in the texts. */
function textMatches(texts: readonly unknown[], query: string): boolean {
  const haystack = texts
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
    .toLowerCase();
  return searchTerms(query).every((term) => haystack.includes(term));
}

const entries = (value: unknown): Array<Record<string, unknown>> =>
  isPlainObject(value)
    ? Object.values(value).filter(isPlainObject)
    : Array.isArray(value)
      ? value.filter(isPlainObject)
      : [];

const members = (value: unknown, names: readonly string[]): unknown[] =>
  entries(value).flatMap((entry) => names.map((name) => entry[name]));

const nameComponents = (card: Card, kind?: string): unknown[] =>
  entries(isPlainObject(card['name']) ? card['name']['components'] : null)
    .filter((component) => kind === undefined || component['kind'] === kind)
    .map((component) => component['value']);

/** Every text in a card that says something about the contact. */
function allText(value: unknown, found: unknown[] = []): unknown[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allText(item, found));
  else if (isPlainObject(value)) {
    for (const [name, member] of Object.entries(value)) {
      if (!['@type', 'id', 'addressBookIds', 'blobId'].includes(name)) {
        allText(member, found);
      }
    }
  }
  return found;
}

const time = (value: unknown): number =>
  typeof value === 'string' ? Date.parse(value) : Number.NaN;

const isText = (value: unknown) => typeof value === 'string';
const isDate = (value: unknown) =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));
const texts = (find: (card: Card) => unknown[]) => ({
  valid: isText,
  matches: (card: Card, value: unknown) =>
    textMatches(find(card), value as string),
});

const CONDITIONS: Record<
  string,
  {
    valid(value: unknown): boolean;
    matches(card: Card, value: unknown): boolean;
  }
> = {
  inAddressBook: {
    valid: isText,
    matches: (card, value) =>
      isPlainObject(card['addressBookIds']) &&
      card['addressBookIds'][value as string] === true,
  },
  uid: { valid: isText, matches: (card, value) => card['uid'] === value },
  hasMember: {
    valid: isText,
    matches: (card, value) =>
      isPlainObject(card['members']) &&
      card['members'][value as string] === true,
  },
  kind: {
    valid: isText,
    // A card that does not say is an individual (RFC 9553 §2.1.4).
    matches: (card, value) => (card['kind'] ?? 'individual') === value,
  },
  createdBefore: {
    valid: isDate,
    matches: (card, value) => time(card['created']) < time(value),
  },
  createdAfter: {
    valid: isDate,
    matches: (card, value) => time(card['created']) >= time(value),
  },
  updatedBefore: {
    valid: isDate,
    matches: (card, value) => time(card['updated']) < time(value),
  },
  updatedAfter: {
    valid: isDate,
    matches: (card, value) => time(card['updated']) >= time(value),
  },
  text: texts((card) => allText(card)),
  name: texts((card) => [
    ...nameComponents(card),
    isPlainObject(card['name']) ? card['name']['full'] : undefined,
  ]),
  'name/given': texts((card) => nameComponents(card, 'given')),
  'name/surname': texts((card) => nameComponents(card, 'surname')),
  'name/surname2': texts((card) => nameComponents(card, 'surname2')),
  nickname: texts((card) => members(card['nicknames'], ['name'])),
  organization: texts((card) => members(card['organizations'], ['name'])),
  email: texts((card) => members(card['emails'], ['address', 'label'])),
  phone: texts((card) => members(card['phones'], ['number', 'label'])),
  onlineService: texts((card) =>
    members(card['onlineServices'], ['service', 'uri', 'user', 'label']),
  ),
  address: texts((card) =>
    entries(card['addresses']).flatMap((address) => [
      address['full'],
      ...members(address['components'], ['value']),
    ]),
  ),
  note: texts((card) => members(card['notes'], ['note'])),
};

const NAME_SORTS = ['name/given', 'name/surname', 'name/surname2'];

const cardQuerySpec: QuerySpec<Card> = {
  validateCondition(condition) {
    for (const [key, value] of Object.entries(condition)) {
      if (!CONDITIONS[key]?.valid(value)) {
        throw new MethodError(
          'invalidArguments',
          `Invalid ContactCard filter property "${key}"`,
        );
      }
    }
  },
  matches: (card, condition) =>
    Object.entries(condition).every(([key, value]) =>
      CONDITIONS[key]?.matches(card, value),
    ),
  comparator(comparator: Comparator): CompareFn<Card> {
    const { property } = comparator;
    if (property === 'created' || property === 'updated') {
      // A card without the date sorts as the oldest.
      return (a, b) => (time(a[property]) || 0) - (time(b[property]) || 0);
    }
    if (NAME_SORTS.includes(property)) {
      const kind = property.slice('name/'.length);
      const key = (card: Card) => String(nameComponents(card, kind)[0] ?? '');
      return (a, b) => compareStrings(key(a), key(b), comparator.collation);
    }
    throw new MethodError(
      'unsupportedSort',
      `Cards cannot be sorted by "${property}"`,
    );
  },
};

interface CardQuery {
  filter?: Record<string, unknown> | null | undefined;
  sort?: Comparator[] | null | undefined;
}

async function queryCards(
  ctx: MethodContext,
  args: CardQuery,
): Promise<string[]> {
  // A filter that names an address book only has that one to look through.
  const [bookId] = requiredConditionValues(args.filter, 'inAddressBook');
  const records =
    typeof bookId === 'string'
      ? await cardsIn(ctx, bookId)
      : await ctx.store.list(ctx.auth.accountId, CONTACT_CARD);
  return filterAndSort(
    records.map(toCard),
    args.filter,
    args.sort,
    cardQuerySpec,
  ).map(({ id }) => id);
}

const CardCopyArgumentsSchema = z.strictObject({
  fromAccountId: z.string(),
  ifFromInState: z.string().nullish(),
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())),
  onSuccessDestroyOriginal: z.boolean().optional(),
  destroyFromIfInState: z.string().nullish(),
});

/** Copies the files a card refers to into the account the card is copied to. */
async function copyMedia(
  from: MethodContext,
  to: MethodContext,
  card: Record<string, unknown>,
): Promise<void> {
  if (!isPlainObject(card['media'])) return;
  const media: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(card['media'])) {
    media[key] = entry;
    if (!isPlainObject(entry) || typeof entry['blobId'] !== 'string') continue;
    const data = await from.readBlob(entry['blobId']);
    if (!data) {
      throw new SetFailure('blobNotFound', 'A file of the card was not found', {
        notFound: [entry['blobId']],
      });
    }
    const blobId = generateId('bu');
    await to.blobs.put(to.auth.accountId, blobId, data);
    media[key] = { ...entry, blobId };
  }
  card['media'] = media;
}

export const contactMethods: Record<string, MethodHandler> = {
  'AddressBook/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, BOOK_PROPERTIES);
    const { state, records, notFound } = await loadForGet(
      ctx,
      ADDRESS_BOOK,
      args.ids,
    );
    const defaultId = await defaultBookId(ctx);
    return {
      accountId,
      state,
      list: records.map((record) =>
        pick(
          describeBook(
            ctx,
            record.id,
            record.value as unknown as AddressBookValue,
            defaultId,
          ),
          properties,
        ),
      ),
      notFound,
    };
  },

  'AddressBook/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, ADDRESS_BOOK, rawArgs)),
  }),

  'AddressBook/set': async (rawArgs, ctx) => {
    const args = parseArguments(AddressBookSetArgumentsSchema, rawArgs);
    const response = await standardSet(
      ctx,
      {
        type: ADDRESS_BOOK,
        create: createBook,
        update: updateBook,
        destroy: (context, id) =>
          destroyBook(context, id, args.onDestroyRemoveContents ?? false),
      },
      args,
    );
    const wanted = args.onSuccessSetIsDefault;
    const succeeded =
      !response.notCreated && !response.notUpdated && !response.notDestroyed;
    const id =
      typeof wanted === 'string' && succeeded
        ? resolveCreationReference(ctx, wanted)
        : undefined;
    const changed = id === undefined ? null : await setDefaultBook(ctx, id);
    if (!changed) return { ...response };

    // What the server changed is reported with the object it changed (RFC 9610 §2.3).
    const created = { ...response.created };
    const updated = { ...response.updated };
    for (const [bookId, change] of Object.entries(changed)) {
      const creationId = Object.keys(created).find(
        (key) => created[key]?.['id'] === bookId,
      );
      if (creationId !== undefined) {
        created[creationId] = { ...created[creationId], ...change };
      } else {
        updated[bookId] = { ...updated[bookId], ...change };
      }
    }
    return {
      ...response,
      newState: await ctx.store.getState(args.accountId, ADDRESS_BOOK),
      created: Object.keys(created).length > 0 ? created : null,
      updated,
    };
  },

  'ContactCard/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const { state, records, notFound } = await loadForGet(
      ctx,
      CONTACT_CARD,
      args.ids,
    );
    // A card may have properties of any name, so any name may be asked for.
    const properties = args.properties
      ? [...new Set(['id', ...args.properties])]
      : null;
    return {
      accountId,
      state,
      list: records.map((record) =>
        properties ? pick(toCard(record), properties) : toCard(record),
      ),
      notFound,
    };
  },

  'ContactCard/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, CONTACT_CARD, rawArgs)),
  }),

  'ContactCard/query': async (rawArgs, ctx) => {
    const args = parseArguments(QueryArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, CONTACT_CARD);
    return { ...paginate(ctx, await queryCards(ctx, args), args, state) };
  },

  'ContactCard/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(QueryChangesArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, CONTACT_CARD);
    const changes = await changesSince(ctx, CONTACT_CARD, args.sinceQueryState);
    const ids = await queryCards(ctx, args);
    return { ...queryChanges(ctx, ids, changes, [], args, state) };
  },

  'ContactCard/set': async (rawArgs, ctx) => ({
    ...(await runCardSet(ctx, parseArguments(SetArgumentsSchema, rawArgs))),
  }),

  'ContactCard/copy': async (rawArgs, ctx) => {
    const args = parseArguments(CardCopyArgumentsSchema, rawArgs);
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
        `At most ${ctx.limits.maxObjectsInSet} cards may be copied in one call`,
      );
    }
    const oldState = await to.store.getState(args.accountId, CONTACT_CARD);
    if (
      (args.ifInState !== null &&
        args.ifInState !== undefined &&
        args.ifInState !== oldState) ||
      (args.ifFromInState !== null &&
        args.ifFromInState !== undefined &&
        args.ifFromInState !==
          (await from.store.getState(args.fromAccountId, CONTACT_CARD)))
    ) {
      throw new MethodError('stateMismatch');
    }

    const created: Record<string, { id: string }> = {};
    const notCreated: Record<string, SetError> = {};
    const copiedFrom: string[] = [];
    for (const [creationId, input] of create) {
      try {
        const { id: sourceId, ...changes } = input;
        if (typeof sourceId !== 'string') {
          throw invalid(['id'], 'id must be the id of the card to copy');
        }
        const [source] = await from.store.get(
          args.fromAccountId,
          CONTACT_CARD,
          [sourceId],
        );
        if (!source) throw new SetFailure('notFound');
        // The copy is the same card; what is not given comes from the original.
        const card: Record<string, unknown> = {
          ...source.value,
          ...changes,
          // The address books of the original are in another account.
          addressBookIds: resolveBookIds(to, changes['addressBookIds']),
        };
        const twin = await findByUid(to, String(card['uid']));
        if (twin) {
          throw new SetFailure(
            'alreadyExists',
            'The account already has a card with this uid',
            { existingId: twin.id },
          );
        }
        if (changes['media'] === undefined) await copyMedia(from, to, card);
        else await checkMedia(to, card);
        const id = await storeNewCard(to, card);
        created[creationId] = { id };
        to.createdIds.set(creationId, id);
        copiedFrom.push(source.id);
      } catch (error) {
        if (!(error instanceof SetFailure)) throw error;
        notCreated[creationId] = error.error;
      }
    }

    if (args.onSuccessDestroyOriginal && copiedFrom.length > 0) {
      // Reported as the ContactCard/set it is, after the copy's own response.
      ctx.extraResponses.push([
        'ContactCard/set',
        {
          ...(await runCardSet(from, {
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
      newState: await to.store.getState(args.accountId, CONTACT_CARD),
      created: Object.keys(created).length > 0 ? created : null,
      notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    };
  },
};
