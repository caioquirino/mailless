import {
  CAPABILITY_MAIL,
  CAPABILITY_QUOTA,
  ChangesArgumentsSchema,
  GetArgumentsSchema,
  MethodError,
  QueryArgumentsSchema,
  QueryChangesArgumentsSchema,
  type Comparator,
} from '@mailless/jmap-core';
import { EMAIL, type EmailRecord } from './model.js';

import {
  ConflictError,
  changesSince,
  compareStrings,
  filterAndSort,
  paginate,
  parseArguments,
  pick,
  queryChanges,
  requireAccount,
  selectProperties,
  standardChanges,
  toChangesResponse,
  type CompareFn,
  type MetadataStore,
  type MethodContext,
  type MethodHandler,
  type QuerySpec,
  type WriteOp,
} from '@mailless/jmap-engine';
export { CAPABILITY_QUOTA };

/*
 * Quotas (RFC 9425). An account has one: how many octets its mail takes up,
 * against a limit the host sets. The count is kept in a record of its own and
 * moves in the same commit as the mail it counts.
 */

export const QUOTA = 'Quota';
/** The one quota of an account. */
export const MAIL_QUOTA_ID = 'mail';

type QuotaValue = { used: number };

interface QuotaObject {
  id: string;
  resourceType: 'octets';
  used: number;
  hardLimit: number;
  warnLimit: null;
  softLimit: null;
  scope: 'account';
  name: string;
  description: null;
  types: string[];
}
const PROPERTIES = [
  'id',
  'resourceType',
  'used',
  'hardLimit',
  'warnLimit',
  'softLimit',
  'scope',
  'name',
  'description',
  'types',
];

async function countMail(ctx: MethodContext): Promise<number> {
  const emails = (await ctx.store.list(
    ctx.auth.accountId,
    EMAIL,
  )) as unknown as EmailRecord[];
  return emails.reduce((total, email) => total + email.value.size, 0);
}

/**
 * Makes sure an account's mail has been counted, and returns the count. The
 * first time, every message already there is added up and the sum is kept,
 * so that nothing has to add them up again: from then on the count moves
 * with each change. Where nothing can be written (an account the user may
 * only read), the sum is returned without being kept.
 */
export async function countedUsage(ctx: MethodContext): Promise<number> {
  const accountId = ctx.auth.accountId;
  const [record] = await ctx.store.get(accountId, QUOTA, [MAIL_QUOTA_ID]);
  if (record) return (record.value as QuotaValue).used;

  const used = await countMail(ctx);
  if (ctx.isReadOnly) return used;
  try {
    await ctx.store.commit(accountId, [
      { kind: 'create', type: QUOTA, id: MAIL_QUOTA_ID, value: { used } },
    ]);
    return used;
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    // Someone else counted it in the meantime, and may have counted mail that
    // came since: theirs is the one that was kept.
    const [kept] = await ctx.store.get(accountId, QUOTA, [MAIL_QUOTA_ID]);
    return kept ? (kept.value as QuotaValue).used : used;
  }
}

/** How many octets the account's mail takes up. */
export const usedOctets = countedUsage;

/**
 * How many octets an account's mail takes up, as last counted, read straight
 * from the store: for something that reports on accounts without being able
 * to read their mail. Null for an account whose mail has not been counted
 * yet, which it is the first time the account is used after this was added.
 */
export async function storedUsage(
  metadata: MetadataStore,
  accountId: string,
): Promise<number | null> {
  const [record] = await metadata.get(accountId, QUOTA, [MAIL_QUOTA_ID]);
  const used = (record?.value as QuotaValue | undefined)?.used;
  return typeof used === 'number' ? Math.max(0, used) : null;
}

/**
 * The write that keeps the count in step, for the commit that adds or removes
 * mail. `delta` is the change in octets.
 */
export async function usageOps(
  ctx: MethodContext,
  delta: number,
): Promise<WriteOp[]> {
  if (delta === 0) return [];
  const [record] = await ctx.store.get(ctx.auth.accountId, QUOTA, [
    MAIL_QUOTA_ID,
  ]);
  if (record) {
    return [
      {
        kind: 'increment',
        type: QUOTA,
        id: MAIL_QUOTA_ID,
        deltas: { used: delta },
      },
    ];
  }
  // The first time, everything already there is counted too.
  return [
    {
      kind: 'create',
      type: QUOTA,
      id: MAIL_QUOTA_ID,
      value: { used: Math.max(0, (await countMail(ctx)) + delta) },
    },
  ];
}

/** The quotas a client may see: none without a limit, or when it did not ask about mail. */
async function listQuotas(ctx: MethodContext): Promise<QuotaObject[]> {
  const hardLimit = await ctx.mail.quotaOctets();
  if (hardLimit === null || !ctx.using.includes(CAPABILITY_MAIL)) return [];
  return [
    {
      id: MAIL_QUOTA_ID,
      resourceType: 'octets',
      used: Math.max(0, await usedOctets(ctx)),
      hardLimit,
      warnLimit: null,
      softLimit: null,
      scope: 'account',
      name: ctx.auth.accountId,
      description: null,
      types: ['Email'],
    },
  ];
}

const isString = (value: unknown) => typeof value === 'string';
const CONDITIONS: Record<
  string,
  (quota: QuotaObject, value: string) => boolean
> = {
  name: (quota, value) =>
    quota.name.toLowerCase().includes(value.toLowerCase()),
  scope: (quota, value) => quota.scope === value,
  resourceType: (quota, value) => quota.resourceType === value,
  type: (quota, value) => quota.types.includes(value),
};

const querySpec: QuerySpec<QuotaObject> = {
  validateCondition(condition) {
    for (const [key, value] of Object.entries(condition)) {
      if (!CONDITIONS[key] || !isString(value)) {
        throw new MethodError(
          'invalidArguments',
          `Invalid Quota filter property "${key}"`,
        );
      }
    }
  },
  matches: (quota, condition) =>
    Object.entries(condition).every(([key, value]) =>
      CONDITIONS[key]?.(quota, value as string),
    ),
  comparator(comparator: Comparator): CompareFn<QuotaObject> {
    switch (comparator.property) {
      case 'name':
        return (a, b) => compareStrings(a.name, b.name, comparator.collation);
      case 'used':
        return (a, b) => a.used - b.used;
      default:
        throw new MethodError(
          'unsupportedSort',
          `Quotas cannot be sorted by "${comparator.property}"`,
        );
    }
  },
};

export const quotaMethods: Record<string, MethodHandler> = {
  'Quota/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, PROPERTIES);
    const state = await ctx.store.getState(accountId, QUOTA);
    const quotas = await listQuotas(ctx);
    const ids = args.ids ? [...new Set(args.ids)] : quotas.map(({ id }) => id);
    return {
      accountId,
      state,
      list: quotas
        .filter((quota) => ids.includes(quota.id))
        .map((quota) => pick({ ...quota }, properties)),
      notFound: ids.filter((id) => !quotas.some((quota) => quota.id === id)),
    };
  },

  'Quota/changes': async (rawArgs, ctx) => {
    parseArguments(ChangesArgumentsSchema, rawArgs);
    const result = await standardChanges(ctx, QUOTA, rawArgs);
    const visible = new Set((await listQuotas(ctx)).map(({ id }) => id));
    const only = (ids: string[]) => ids.filter((id) => visible.has(id));
    const updated = only([...result.created, ...result.updated]);
    // The record behind a quota holds nothing but its usage: the rest comes
    // from the server's settings and is not in the log. So whatever changed
    // here is the usage, which lets a client fetch just that.
    return {
      ...toChangesResponse(result),
      // The quota exists from the moment there is a limit, whatever the count's record says.
      created: [],
      updated,
      destroyed: [],
      updatedProperties: updated.length > 0 ? ['used'] : null,
    };
  },

  'Quota/query': async (rawArgs, ctx) => {
    const args = parseArguments(QueryArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, QUOTA);
    const ids = filterAndSort(
      await listQuotas(ctx),
      args.filter,
      args.sort,
      querySpec,
    ).map(({ id }) => id);
    return { ...paginate(ctx, ids, args, state) };
  },

  'Quota/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(QueryChangesArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, QUOTA);
    const changes = await changesSince(ctx, QUOTA, args.sinceQueryState);
    const quotas = await listQuotas(ctx);
    const ids = filterAndSort(quotas, args.filter, args.sort, querySpec).map(
      ({ id }) => id,
    );
    const visible = new Set(quotas.map(({ id }) => id));
    return {
      ...queryChanges(
        ctx,
        ids,
        // The record was made some time after the quota a client already saw.
        changes
          .filter((entry) => visible.has(entry.id))
          .map((entry) => ({ ...entry, kind: 'updated' as const })),
        [],
        args,
        state,
      ),
    };
  },
};
