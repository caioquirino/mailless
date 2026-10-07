import {
  applyPatch,
  GetArgumentsSchema,
  MethodError,
  PatchError,
  QueryArgumentsSchema,
  QueryChangesArgumentsSchema,
  SetArgumentsSchema,
  SetFailure,
  type Comparator,
} from '@mailless/jmap-core';
import { z } from 'zod';
import {
  commit,
  generateId,
  parseArguments,
  requireAccount,
  retryOnConflict,
  type MethodContext,
  type MethodHandler,
} from '../context.js';
import { standardChanges, toChangesResponse } from '../standard/changes.js';
import { loadForGet, pick, selectProperties } from '../standard/get.js';
import {
  compareStrings,
  evaluateFilter,
  filterAndSort,
  paginate,
  validateFilter,
  type CompareFn,
  type QuerySpec,
} from '../standard/query.js';
import {
  resolveCreationReference,
  standardSet,
  type SetSpec,
} from '../standard/set.js';
import { removeFromMailbox } from './email-store.js';
import {
  asJson,
  EMAIL,
  MAILBOX,
  MAILBOX_COUNT_PROPERTIES,
  type MailboxRecord,
  type MailboxValue,
} from './model.js';

const MUTABLE_PROPERTIES = [
  'name',
  'parentId',
  'role',
  'sortOrder',
  'isSubscribed',
] as const;
type MutableProperty = (typeof MUTABLE_PROPERTIES)[number];
type MutableMailbox = Pick<MailboxValue, MutableProperty>;

const ALL_PROPERTIES = [
  'id',
  ...MUTABLE_PROPERTIES,
  ...MAILBOX_COUNT_PROPERTIES,
  'myRights',
];

const MAX_NAME_BYTES = 255;
export const MAX_MAILBOX_DEPTH = 10;

const OWNER_RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};

type MailboxObject = MailboxValue & {
  id: string;
  myRights: typeof OWNER_RIGHTS;
};

function toObject(record: MailboxRecord): MailboxObject {
  return { id: record.id, ...record.value, myRights: OWNER_RIGHTS };
}

async function listMailboxes(ctx: MethodContext): Promise<MailboxRecord[]> {
  return (await ctx.store.list(
    ctx.auth.accountId,
    MAILBOX,
  )) as unknown as MailboxRecord[];
}

function invalid(properties: string[], description: string): SetFailure {
  return new SetFailure('invalidProperties', description, { properties });
}

/** Checks one mailbox against the rest of the account; `id` is null for a mailbox being created. */
function validate(
  id: string | null,
  mailbox: MutableMailbox,
  all: readonly MailboxRecord[],
): void {
  const others = all.filter((record) => record.id !== id);

  if (typeof mailbox.name !== 'string' || mailbox.name.length === 0) {
    throw invalid(['name'], 'name must be a non-empty string');
  }
  if (new TextEncoder().encode(mailbox.name).length > MAX_NAME_BYTES) {
    throw invalid(['name'], `name must be at most ${MAX_NAME_BYTES} bytes`);
  }
  if (mailbox.parentId !== null && typeof mailbox.parentId !== 'string') {
    throw invalid(['parentId'], 'parentId must be an id or null');
  }
  if (mailbox.role !== null && typeof mailbox.role !== 'string') {
    throw invalid(['role'], 'role must be a string or null');
  }
  if (!Number.isInteger(mailbox.sortOrder) || mailbox.sortOrder < 0) {
    throw invalid(['sortOrder'], 'sortOrder must be a non-negative integer');
  }
  if (typeof mailbox.isSubscribed !== 'boolean') {
    throw invalid(['isSubscribed'], 'isSubscribed must be a boolean');
  }

  const byId = new Map(others.map((record) => [record.id, record]));
  let depth = 1;
  for (let ancestorId = mailbox.parentId; ancestorId !== null; depth += 1) {
    if (ancestorId === id) {
      throw invalid(['parentId'], 'A mailbox cannot be its own ancestor');
    }
    const ancestor = byId.get(ancestorId);
    if (!ancestor)
      throw invalid(['parentId'], 'The parent mailbox does not exist');
    ancestorId = ancestor.value.parentId;
  }
  if (depth > MAX_MAILBOX_DEPTH) {
    throw invalid(
      ['parentId'],
      `Mailboxes can be nested at most ${MAX_MAILBOX_DEPTH} levels deep`,
    );
  }

  if (
    others.some(
      (record) =>
        record.value.parentId === mailbox.parentId &&
        record.value.name === mailbox.name,
    )
  ) {
    throw invalid(['name'], 'A sibling mailbox already has this name');
  }
  if (
    mailbox.role !== null &&
    others.some((record) => record.value.role === mailbox.role)
  ) {
    throw invalid(['role'], 'Another mailbox already has this role');
  }
}

/**
 * Takes the properties only the server sets out of what a client sent. A
 * client may send them back as it received them (RFC 8620 §5.3), so values
 * equal to the server's own are dropped; anything else is refused, naming each
 * property, or each right within myRights, that differs.
 */
function withoutServerSet(
  input: Record<string, unknown>,
  serverSet: Record<string, unknown>,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [path, value] of Object.entries(input)) {
    const [property, ...deeper] = path.split('/') as [string, ...string[]];
    if ((MUTABLE_PROPERTIES as readonly string[]).includes(property)) {
      rest[path] = value;
    } else if (!Object.prototype.hasOwnProperty.call(serverSet, property)) {
      refused.push(path);
    } else if (property === 'myRights') {
      const rights = serverSet['myRights'] as Record<string, unknown>;
      if (deeper.length === 1) {
        if (rights[deeper[0] as string] !== value) refused.push(path);
      } else if (
        deeper.length > 1 ||
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value)
      ) {
        refused.push(path);
      } else {
        for (const [right, allowed] of Object.entries(value)) {
          if (rights[right] !== allowed) refused.push(`myRights/${right}`);
        }
      }
    } else if (deeper.length > 0 || serverSet[property] !== value) {
      refused.push(path);
    }
  }
  if (refused.length > 0) {
    throw invalid(refused, 'These properties cannot be set by the client');
  }
  return rest;
}

async function createMailbox(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  // The id is not known to the client beforehand, so any id given is wrong.
  input = withoutServerSet(input, {
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: OWNER_RIGHTS,
  });

  let parentId: unknown = input['parentId'] ?? null;
  if (typeof parentId === 'string') {
    parentId = resolveCreationReference(ctx, parentId);
    if (parentId === undefined) {
      throw invalid(['parentId'], 'Unknown creation id');
    }
  }
  const role = input['role'] ?? null;
  const mailbox = {
    name: input['name'],
    parentId,
    role: typeof role === 'string' ? role.toLowerCase() : role,
    sortOrder: input['sortOrder'] ?? 0,
    isSubscribed: input['isSubscribed'] ?? true,
  } as MutableMailbox;

  validate(null, mailbox, await listMailboxes(ctx));

  const id = generateId('mb');
  const value: MailboxValue = {
    ...mailbox,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
  };
  await commit(ctx, [
    { kind: 'create', type: MAILBOX, id, value: asJson(value) },
  ]);

  const serverSet: { id: string } & Record<string, unknown> = {
    id,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: OWNER_RIGHTS,
  };
  for (const property of [
    'parentId',
    'role',
    'sortOrder',
    'isSubscribed',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, property)) {
      serverSet[property] = value[property];
    }
  }
  return serverSet;
}

async function updateMailbox(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<null> {
  await retryOnConflict(async () => {
    const all = await listMailboxes(ctx);
    const record = all.find((candidate) => candidate.id === id);
    if (!record) throw new SetFailure('notFound');
    const mutablePatch = withoutServerSet(patch, {
      id,
      totalEmails: record.value.totalEmails,
      unreadEmails: record.value.unreadEmails,
      totalThreads: record.value.totalThreads,
      unreadThreads: record.value.unreadThreads,
      myRights: OWNER_RIGHTS,
    });

    const current: MutableMailbox = {
      name: record.value.name,
      parentId: record.value.parentId,
      role: record.value.role,
      sortOrder: record.value.sortOrder,
      isSubscribed: record.value.isSubscribed,
    };
    let next: MutableMailbox;
    try {
      next = applyPatch(current, mutablePatch);
    } catch (error) {
      if (error instanceof PatchError) {
        throw new SetFailure('invalidPatch', error.message);
      }
      throw error;
    }
    if (typeof next.role === 'string') next.role = next.role.toLowerCase();

    const changedProperties = MUTABLE_PROPERTIES.filter(
      (property) => next[property] !== current[property],
    );
    if (changedProperties.length === 0) return;

    validate(id, next, all);
    await commit(ctx, [
      {
        kind: 'update',
        type: MAILBOX,
        id,
        value: asJson({ ...record.value, ...next }),
        expectedVersion: record.version,
        changedProperties,
      },
    ]);
  });
  return null;
}

async function destroyMailbox(
  ctx: MethodContext,
  id: string,
  removeEmails: boolean,
): Promise<void> {
  const accountId = ctx.auth.accountId;
  const all = await listMailboxes(ctx);
  if (!all.some((record) => record.id === id)) throw new SetFailure('notFound');
  if (all.some((record) => record.value.parentId === id)) {
    throw new SetFailure('mailboxHasChild');
  }

  const emails = await ctx.store.list(accountId, EMAIL, {
    name: 'mailbox',
    value: id,
  });
  if (emails.length > 0 && !removeEmails) {
    throw new SetFailure('mailboxHasEmail');
  }
  for (const email of emails) await removeFromMailbox(ctx, email.id, id);

  await retryOnConflict(async () => {
    const [record] = await ctx.store.get(accountId, MAILBOX, [id]);
    if (!record) return;
    await commit(ctx, [
      { kind: 'destroy', type: MAILBOX, id, expectedVersion: record.version },
    ]);
  });
}

const querySpec: QuerySpec<MailboxObject> = {
  validateCondition(condition) {
    for (const [key, value] of Object.entries(condition)) {
      const ok =
        key === 'parentId' || key === 'role'
          ? value === null || typeof value === 'string'
          : key === 'name'
            ? typeof value === 'string'
            : key === 'hasAnyRole' || key === 'isSubscribed'
              ? typeof value === 'boolean'
              : undefined;
      if (ok === undefined) {
        throw new MethodError(
          'invalidArguments',
          `Unknown Mailbox filter property "${key}"`,
        );
      }
      if (!ok) {
        throw new MethodError(
          'invalidArguments',
          `Invalid value for Mailbox filter property "${key}"`,
        );
      }
    }
  },
  matches(mailbox, condition) {
    if ('parentId' in condition && mailbox.parentId !== condition['parentId']) {
      return false;
    }
    if ('role' in condition && mailbox.role !== condition['role']) return false;
    if (
      'name' in condition &&
      !mailbox.name
        .toLowerCase()
        .includes((condition['name'] as string).toLowerCase())
    ) {
      return false;
    }
    if (
      'hasAnyRole' in condition &&
      (mailbox.role !== null) !== condition['hasAnyRole']
    ) {
      return false;
    }
    if (
      'isSubscribed' in condition &&
      mailbox.isSubscribed !== condition['isSubscribed']
    ) {
      return false;
    }
    return true;
  },
  comparator(comparator: Comparator): CompareFn<MailboxObject> {
    switch (comparator.property) {
      case 'sortOrder':
        return (a, b) => a.sortOrder - b.sortOrder;
      case 'name':
        return (a, b) => compareStrings(a.name, b.name);
      case 'parentId':
        return (a, b) => compareStrings(a.parentId ?? '', b.parentId ?? '');
      default:
        throw new MethodError(
          'unsupportedSort',
          `Mailboxes cannot be sorted by "${comparator.property}"`,
        );
    }
  },
};

/** Pre-order walk: every mailbox directly follows its parent, siblings keep their sorted order. */
function orderAsTree(sorted: readonly MailboxObject[]): MailboxObject[] {
  const ids = new Set(sorted.map((mailbox) => mailbox.id));
  const children = new Map<string | null, MailboxObject[]>();
  for (const mailbox of sorted) {
    const parent =
      mailbox.parentId !== null && ids.has(mailbox.parentId)
        ? mailbox.parentId
        : null;
    children.set(parent, [...(children.get(parent) ?? []), mailbox]);
  }
  const result: MailboxObject[] = [];
  const visit = (parent: string | null): void => {
    for (const mailbox of children.get(parent) ?? []) {
      result.push(mailbox);
      visit(mailbox.id);
    }
  };
  visit(null);
  return result;
}

const MailboxQueryArgumentsSchema = QueryArgumentsSchema.extend({
  sortAsTree: z.boolean().optional(),
  filterAsTree: z.boolean().optional(),
});

const MailboxSetArgumentsSchema = SetArgumentsSchema.extend({
  onDestroyRemoveEmails: z.boolean().optional(),
});

export const mailboxMethods: Record<string, MethodHandler> = {
  'Mailbox/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, ALL_PROPERTIES);
    const { state, records, notFound } = await loadForGet(
      ctx,
      MAILBOX,
      args.ids,
    );
    return {
      accountId,
      state,
      list: (records as unknown as MailboxRecord[]).map((record) =>
        pick(toObject(record), properties),
      ),
      notFound,
    };
  },

  'Mailbox/changes': async (rawArgs, ctx) => {
    const result = await standardChanges(ctx, MAILBOX, rawArgs);

    // When only counts changed, tell the client so it can skip refetching everything (RFC 8621 §2.2).
    const details = [...result.updatedDetail.values()];
    const countsOnly =
      details.length > 0 &&
      result.created.length === 0 &&
      details.every(
        (properties) =>
          properties !== null &&
          properties.every((property) =>
            (MAILBOX_COUNT_PROPERTIES as readonly string[]).includes(property),
          ),
      );
    return {
      ...toChangesResponse(result),
      updatedProperties: countsOnly
        ? [...new Set(details.flatMap((properties) => properties ?? []))]
        : null,
    };
  },

  'Mailbox/query': async (rawArgs, ctx) => {
    const args = parseArguments(MailboxQueryArgumentsSchema, rawArgs);
    requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(ctx.auth.accountId, MAILBOX);
    const all = (await listMailboxes(ctx)).map(toObject);

    let ordered = filterAndSort(all, null, args.sort, querySpec);
    if (args.sortAsTree) ordered = orderAsTree(ordered);

    let matched = new Set(all.map((mailbox) => mailbox.id));
    const filter = args.filter;
    if (filter) {
      validateFilter(filter, (c) => querySpec.validateCondition(c));
      matched = new Set(
        all
          .filter((mailbox) =>
            evaluateFilter(filter, mailbox, (m, c) => querySpec.matches(m, c)),
          )
          .map((mailbox) => mailbox.id),
      );
      if (args.filterAsTree) {
        const byId = new Map(all.map((mailbox) => [mailbox.id, mailbox]));
        const ancestorsMatch = (mailbox: MailboxObject): boolean => {
          for (
            let parent = mailbox.parentId
              ? byId.get(mailbox.parentId)
              : undefined;
            parent;
            parent = parent.parentId ? byId.get(parent.parentId) : undefined
          ) {
            if (!matched.has(parent.id)) return false;
          }
          return true;
        };
        matched = new Set(
          all
            .filter(
              (mailbox) => matched.has(mailbox.id) && ancestorsMatch(mailbox),
            )
            .map((mailbox) => mailbox.id),
        );
      }
    }

    const ids = ordered
      .filter((mailbox) => matched.has(mailbox.id))
      .map((mailbox) => mailbox.id);
    return { ...paginate(ctx, ids, args, state) };
  },

  'Mailbox/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(
      QueryChangesArgumentsSchema.extend({
        sortAsTree: z.boolean().optional(),
        filterAsTree: z.boolean().optional(),
      }),
      rawArgs,
    );
    requireAccount(ctx, args.accountId);
    throw new MethodError('cannotCalculateChanges');
  },

  'Mailbox/set': async (rawArgs, ctx) => {
    const args = parseArguments(MailboxSetArgumentsSchema, rawArgs);
    const spec: SetSpec = {
      type: MAILBOX,
      create: createMailbox,
      update: updateMailbox,
      destroy: (context, id) =>
        destroyMailbox(context, id, args.onDestroyRemoveEmails ?? false),
    };
    return { ...(await standardSet(ctx, spec, args)) };
  },
};

const STANDARD_MAILBOXES: Array<{
  name: string;
  role: string;
  sortOrder: number;
}> = [
  { name: 'Inbox', role: 'inbox', sortOrder: 1 },
  { name: 'Drafts', role: 'drafts', sortOrder: 2 },
  { name: 'Sent', role: 'sent', sortOrder: 3 },
  { name: 'Archive', role: 'archive', sortOrder: 4 },
  { name: 'Junk', role: 'junk', sortOrder: 5 },
  { name: 'Trash', role: 'trash', sortOrder: 6 },
];

/** Creates the standard role mailboxes for an account that has none yet. */
export async function provisionMailboxes(ctx: MethodContext): Promise<void> {
  if ((await listMailboxes(ctx)).length > 0) return;
  for (const mailbox of STANDARD_MAILBOXES) {
    await createMailbox(ctx, { ...mailbox, isSubscribed: true });
  }
}
