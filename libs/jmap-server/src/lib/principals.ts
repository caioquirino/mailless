import {
  CAPABILITY_PRINCIPALS,
  ChangesArgumentsSchema,
  GetArgumentsSchema,
  MethodError,
  QueryArgumentsSchema,
  QueryChangesArgumentsSchema,
  SetArgumentsSchema,
  type Comparator,
  type SetError,
} from '@mailless/jmap-core';
import {
  commit,
  fingerprint,
  parseArguments,
  requireAccount,
  type MethodContext,
  type MethodHandler,
} from './context.js';
import { standardChanges, toChangesResponse } from './standard/changes.js';
import { loadForGet, pick, selectProperties } from './standard/get.js';
import {
  changesSince,
  compareStrings,
  filterAndSort,
  paginate,
  queryChanges,
  type CompareFn,
  type QuerySpec,
} from './standard/query.js';

export { CAPABILITY_PRINCIPALS };

/*
 * Principals and share notifications (RFC 9670). A principal stands for
 * whoever owns an account. A user sees the principals of the accounts they
 * may use: their own, and one for each account shared with them.
 */

/** One principal as the host describes it. */
export interface Principal {
  id: string;
  type: 'individual' | 'group' | 'resource' | 'location' | 'other';
  name: string;
  description: string | null;
  email: string | null;
  timeZone: string | null;
  capabilities: Record<string, unknown>;
  /** The accounts holding this principal's data that the user may use. */
  accounts: Record<string, unknown> | null;
}

const PRINCIPAL_PROPERTIES = [
  'id',
  'type',
  'name',
  'description',
  'email',
  'timeZone',
  'capabilities',
  'accounts',
];

/** Principals live in the user's own account; a shared account holds none. */
async function listPrincipals(ctx: MethodContext): Promise<Principal[]> {
  return ctx.auth.accountId === ctx.user.accountId ? ctx.principals() : [];
}

/** Principals come from configuration, so their state is a digest of what they are. */
function principalState(principals: readonly Principal[]): string {
  return `p${fingerprint(JSON.stringify(principals))}`;
}

const contains = (text: string | null, part: string) =>
  (text ?? '').toLowerCase().includes(part.toLowerCase());
const CONDITIONS: Record<
  string,
  {
    valid(value: unknown): boolean;
    matches(principal: Principal, value: unknown): boolean;
  }
> = {
  accountIds: {
    valid: (value) =>
      Array.isArray(value) && value.every((id) => typeof id === 'string'),
    matches: (principal, value) =>
      (value as string[]).some((id) =>
        Object.prototype.hasOwnProperty.call(principal.accounts ?? {}, id),
      ),
  },
  email: {
    valid: (value) => typeof value === 'string',
    matches: (principal, value) => contains(principal.email, value as string),
  },
  name: {
    valid: (value) => typeof value === 'string',
    matches: (principal, value) => contains(principal.name, value as string),
  },
  text: {
    valid: (value) => typeof value === 'string',
    matches: (principal, value) =>
      contains(principal.name, value as string) ||
      contains(principal.email, value as string) ||
      contains(principal.description, value as string),
  },
  type: {
    valid: (value) => typeof value === 'string',
    matches: (principal, value) => principal.type === value,
  },
  timeZone: {
    valid: (value) => typeof value === 'string',
    matches: (principal, value) => principal.timeZone === value,
  },
};

const principalQuerySpec: QuerySpec<Principal> = {
  validateCondition(condition) {
    for (const [key, value] of Object.entries(condition)) {
      if (!CONDITIONS[key]?.valid(value)) {
        throw new MethodError(
          'invalidArguments',
          `Invalid Principal filter property "${key}"`,
        );
      }
    }
  },
  matches: (principal, condition) =>
    Object.entries(condition).every(([key, value]) =>
      CONDITIONS[key]?.matches(principal, value),
    ),
  comparator(comparator: Comparator): CompareFn<Principal> {
    if (comparator.property !== 'name') {
      throw new MethodError(
        'unsupportedSort',
        `Principals cannot be sorted by "${comparator.property}"`,
      );
    }
    return (a, b) => compareStrings(a.name, b.name, comparator.collation);
  },
};

const refuse = (
  ids: string[],
  description: string,
): Record<string, SetError> | null =>
  ids.length === 0
    ? null
    : Object.fromEntries(
        ids.map((id): [string, SetError] => [
          id,
          { type: 'forbidden', description },
        ]),
      );

// ------------------------------------------------------ share notifications

const SHARE_NOTIFICATION = 'ShareNotification';
const NOTIFICATION_PROPERTIES = [
  'id',
  'created',
  'changedBy',
  'objectType',
  'objectAccountId',
  'objectId',
  'oldRights',
  'newRights',
  'name',
];

type Notification = { id: string } & Record<string, unknown>;

async function listNotifications(ctx: MethodContext): Promise<Notification[]> {
  return (await ctx.store.list(ctx.auth.accountId, SHARE_NOTIFICATION)).map(
    (record) => ({ id: record.id, ...record.value }),
  );
}

const isDate = (value: unknown) =>
  value === null ||
  (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
const notificationQuerySpec: QuerySpec<Notification> = {
  validateCondition(condition) {
    for (const [key, value] of Object.entries(condition)) {
      const valid =
        key === 'after' || key === 'before'
          ? isDate(value)
          : key === 'objectType' || key === 'objectAccountId'
            ? value === null || typeof value === 'string'
            : false;
      if (!valid) {
        throw new MethodError(
          'invalidArguments',
          `Invalid ShareNotification filter property "${key}"`,
        );
      }
    }
  },
  matches(notification, condition) {
    const created = Date.parse(String(notification['created']));
    return Object.entries(condition).every(([key, value]) => {
      if (value === null) return true;
      if (key === 'after') return created >= Date.parse(value as string);
      if (key === 'before') return created < Date.parse(value as string);
      return notification[key] === value;
    });
  },
  comparator(comparator: Comparator): CompareFn<Notification> {
    if (comparator.property !== 'created') {
      throw new MethodError(
        'unsupportedSort',
        `Share notifications cannot be sorted by "${comparator.property}"`,
      );
    }
    return (a, b) =>
      Date.parse(String(a['created'])) - Date.parse(String(b['created']));
  },
};

export const principalMethods: Record<string, MethodHandler> = {
  'Principal/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, PRINCIPAL_PROPERTIES);
    const principals = await listPrincipals(ctx);
    const ids = args.ids
      ? [...new Set(args.ids)]
      : principals.map(({ id }) => id);
    return {
      accountId,
      state: principalState(principals),
      list: principals
        .filter((principal) => ids.includes(principal.id))
        .map((principal) => pick({ ...principal }, properties)),
      notFound: ids.filter(
        (id) => !principals.some((principal) => principal.id === id),
      ),
    };
  },

  'Principal/changes': async (rawArgs, ctx) => {
    const args = parseArguments(ChangesArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = principalState(await listPrincipals(ctx));
    // There is no history of a directory that comes from configuration.
    if (args.sinceState !== state) {
      throw new MethodError('cannotCalculateChanges');
    }
    return {
      accountId,
      oldState: state,
      newState: state,
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: [],
    };
  },

  'Principal/query': async (rawArgs, ctx) => {
    const args = parseArguments(QueryArgumentsSchema, rawArgs);
    requireAccount(ctx, args.accountId);
    const principals = await listPrincipals(ctx);
    const ids = filterAndSort(
      principals,
      args.filter,
      args.sort,
      principalQuerySpec,
    ).map(({ id }) => id);
    return {
      ...paginate(ctx, ids, args, principalState(principals)),
      // A changed directory can only be fetched again.
      canCalculateChanges: false,
    };
  },

  'Principal/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(QueryChangesArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const principals = await listPrincipals(ctx);
    const state = principalState(principals);
    if (args.sinceQueryState !== state) {
      throw new MethodError('cannotCalculateChanges');
    }
    return {
      accountId,
      oldQueryState: state,
      newQueryState: state,
      ...(args.calculateTotal
        ? {
            total: filterAndSort(
              principals,
              args.filter,
              args.sort,
              principalQuerySpec,
            ).length,
          }
        : {}),
      removed: [],
      added: [],
    };
  },

  'Principal/set': async (rawArgs, ctx) => {
    const args = parseArguments(SetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = principalState(await listPrincipals(ctx));
    if (args.ifInState && args.ifInState !== state) {
      throw new MethodError('stateMismatch');
    }
    const reason = 'Principals are managed by the server, not through this API';
    return {
      accountId,
      oldState: state,
      newState: state,
      created: null,
      updated: null,
      destroyed: null,
      notCreated: refuse(Object.keys(args.create ?? {}), reason),
      notUpdated: refuse(Object.keys(args.update ?? {}), reason),
      notDestroyed: refuse(args.destroy ?? [], reason),
    };
  },

  'ShareNotification/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(
      args.properties,
      NOTIFICATION_PROPERTIES,
    );
    const { state, records, notFound } = await loadForGet(
      ctx,
      SHARE_NOTIFICATION,
      args.ids,
    );
    return {
      accountId,
      state,
      list: records.map((record) =>
        pick({ id: record.id, ...record.value }, properties),
      ),
      notFound,
    };
  },

  'ShareNotification/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(
      await standardChanges(ctx, SHARE_NOTIFICATION, rawArgs),
    ),
  }),

  'ShareNotification/query': async (rawArgs, ctx) => {
    const args = parseArguments(QueryArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, SHARE_NOTIFICATION);
    const ids = filterAndSort(
      await listNotifications(ctx),
      args.filter,
      args.sort,
      notificationQuerySpec,
    ).map(({ id }) => id);
    return { ...paginate(ctx, ids, args, state) };
  },

  'ShareNotification/queryChanges': async (rawArgs, ctx) => {
    const args = parseArguments(QueryChangesArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const state = await ctx.store.getState(accountId, SHARE_NOTIFICATION);
    const changes = await changesSince(
      ctx,
      SHARE_NOTIFICATION,
      args.sinceQueryState,
    );
    const ids = filterAndSort(
      await listNotifications(ctx),
      args.filter,
      args.sort,
      notificationQuerySpec,
    ).map(({ id }) => id);
    return { ...queryChanges(ctx, ids, changes, [], args, state) };
  },

  'ShareNotification/set': async (rawArgs, ctx) => {
    const args = parseArguments(SetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const oldState = await ctx.store.getState(accountId, SHARE_NOTIFICATION);
    if (args.ifInState && args.ifInState !== oldState) {
      throw new MethodError('stateMismatch');
    }
    // A notification can only be dismissed, which is to destroy it.
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};
    for (const id of [...new Set(args.destroy ?? [])]) {
      const [record] = await ctx.store.get(accountId, SHARE_NOTIFICATION, [id]);
      if (!record) {
        notDestroyed[id] = { type: 'notFound' };
        continue;
      }
      await commit(ctx, [
        {
          kind: 'destroy',
          type: SHARE_NOTIFICATION,
          id,
          expectedVersion: record.version,
        },
      ]);
      destroyed.push(id);
    }
    const reason = 'Share notifications are created by the server';
    return {
      accountId,
      oldState,
      newState: await ctx.store.getState(accountId, SHARE_NOTIFICATION),
      created: null,
      updated: null,
      destroyed: destroyed.length > 0 ? destroyed : null,
      notCreated: refuse(Object.keys(args.create ?? {}), reason),
      notUpdated: refuse(Object.keys(args.update ?? {}), reason),
      notDestroyed: Object.keys(notDestroyed).length > 0 ? notDestroyed : null,
    };
  },
};
