import { MethodError, SetFailure, type SetError } from '@mailless/jmap-core';
import { z } from 'zod';
import {
  generateId,
  parseArguments,
  retryOnConflict,
  toUtcDate,
  type MethodContext,
  type MethodHandler,
} from '../context.js';
import { pick, selectProperties } from '../standard/get.js';
import {
  ConflictError,
  type MetadataStore,
  type StoredRecord,
} from '../storage.js';
import { encryptPush, isUsablePushKeys, type PushKeys } from './encryption.js';

/** The data type push subscriptions are stored under. */
export const PUSH_SUBSCRIPTION = 'PushSubscription';

export interface PushOptions {
  /** Makes the requests to push services. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Whether a subscription may name this URL. The default accepts https URLs
   * with a public-looking host name; see `isPublicHttpsUrl`.
   */
  allowUrl?: (url: URL) => boolean;
  /** How many subscriptions one account may hold. Default 16. */
  maxSubscriptions?: number;
  /**
   * The longest a subscription lives unless the client renews it, in seconds.
   * Default 30 days; RFC 8620 asks for at least 7.
   */
  maxLifetimeSeconds?: number;
  /** How long to wait for a push service to answer, in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** The clock, for tests. */
  now?: () => Date;
}

export type ResolvedPushOptions = Required<PushOptions> & {
  /** The data types whose state changes are pushed: those the server's modules name. */
  pushedTypes: readonly string[];
};

/** What one round of pushing did, in counts. */
export interface PushReport {
  /** Pushes a push service accepted. */
  sent: number;
  /** Pushes that were refused, timed out, or could not be made. */
  failed: number;
  /** Subscriptions destroyed because they expired or their push service no longer knows them. */
  removed: number;
}

const HOSTS_NEVER_PUBLIC =
  /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example|onion|arpa)$/;

/**
 * Whether a URL is https and names a host that looks public: a domain name
 * rather than an IP address, and not under a suffix reserved for private use.
 * The name is not resolved, so this does not stop a public name that points
 * at a private address; hosts that can reach private networks should also
 * restrict where the server may connect.
 */
export function isPublicHttpsUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // The URL parser has already turned every spelling of an IPv4 address into dotted decimals.
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return false;
  return host.includes('.') && !HOSTS_NEVER_PUBLIC.test(host);
}

export function resolvePushOptions(
  options: PushOptions,
  pushedTypes: readonly string[],
): ResolvedPushOptions {
  return {
    pushedTypes,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    allowUrl: options.allowUrl ?? isPublicHttpsUrl,
    maxSubscriptions: options.maxSubscriptions ?? 16,
    maxLifetimeSeconds: options.maxLifetimeSeconds ?? 30 * 24 * 60 * 60,
    timeoutMs: options.timeoutMs ?? 5000,
    now: options.now ?? (() => new Date()),
  };
}

type SubscriptionValue = {
  deviceClientId: string;
  url: string;
  keys: PushKeys | null;
  /** The code sent to the URL. The subscription is verified once the client has echoed it. */
  code: string;
  verificationCode: string | null;
  expires: string;
  types: string[] | null;
  /** Set when the push service asked for fewer requests; nothing is sent before this time. */
  pausedUntil?: string;
};
type SubscriptionRecord = StoredRecord<SubscriptionValue>;

const MAX_URL_LENGTH = 2048;
const MAX_TYPES = 64;
const DEFAULT_PAUSE_SECONDS = 60;
const MAX_PAUSE_SECONDS = 60 * 60;
/** How long a push service should keep an undelivered push. A later one replaces it anyway. */
const TTL_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();

/** What clients may read. The URL and keys are private to the device that set them. */
const VISIBLE_PROPERTIES = [
  'id',
  'deviceClientId',
  'verificationCode',
  'expires',
  'types',
];

function invalid(property: string, description: string): SetFailure {
  return new SetFailure('invalidProperties', description, {
    properties: [property],
  });
}

function isExpired(value: SubscriptionValue, now: Date): boolean {
  return Date.parse(value.expires) <= now.getTime();
}

function isVerified(value: SubscriptionValue): boolean {
  return value.verificationCode === value.code;
}

/** The expiry to store: what was asked for, but in the future and within the server's limit. */
function chooseExpiry(requested: unknown, push: ResolvedPushOptions): string {
  const now = push.now().getTime();
  const latest = now + push.maxLifetimeSeconds * 1000;
  if (requested === null || requested === undefined) {
    return toUtcDate(new Date(latest));
  }
  const time = typeof requested === 'string' ? Date.parse(requested) : NaN;
  if (
    typeof requested !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(requested) ||
    Number.isNaN(time)
  ) {
    throw invalid('expires', 'expires must be a UTC date or null');
  }
  if (time <= now) throw invalid('expires', 'expires must be in the future');
  return toUtcDate(new Date(Math.min(time, latest)));
}

function parseTypes(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length > MAX_TYPES ||
    !value.every((type) => typeof type === 'string' && type.length <= 255)
  ) {
    throw invalid('types', 'types must be a list of type names or null');
  }
  return [...new Set(value as string[])];
}

type PushOutcome =
  { kind: 'sent' | 'failed' | 'gone' } | { kind: 'paused'; seconds: number };

function retryAfterSeconds(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const date = header === null ? NaN : Date.parse(header);
  const wait = Number.isFinite(seconds)
    ? seconds
    : Number.isNaN(date)
      ? DEFAULT_PAUSE_SECONDS
      : (date - Date.now()) / 1000;
  return Math.min(MAX_PAUSE_SECONDS, Math.max(1, Math.ceil(wait)));
}

/** POSTs one object to a subscription's URL (RFC 8030), encrypted when the client gave keys. */
async function post(
  push: ResolvedPushOptions,
  value: SubscriptionValue,
  body: Record<string, unknown>,
  topic?: string,
): Promise<PushOutcome> {
  try {
    const json = encoder.encode(JSON.stringify(body));
    const headers: Record<string, string> = {
      TTL: String(TTL_SECONDS),
      // Lets the push service drop an undelivered push when a newer one arrives.
      ...(topic ? { Topic: topic } : {}),
      ...(value.keys
        ? {
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
          }
        : { 'Content-Type': 'application/json' }),
    };
    const response = await push.fetch(value.url, {
      method: 'POST',
      headers,
      body: value.keys ? await encryptPush(json, value.keys) : json,
      // A redirect could lead anywhere, including places the URL check would have refused.
      redirect: 'manual',
      signal: AbortSignal.timeout(push.timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404 || response.status === 410) {
      return { kind: 'gone' };
    }
    if (response.status === 429) {
      return {
        kind: 'paused',
        seconds: retryAfterSeconds(response.headers.get('retry-after')),
      };
    }
    return { kind: response.ok ? 'sent' : 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

async function destroyQuietly(
  store: MetadataStore,
  accountId: string,
  record: StoredRecord,
): Promise<void> {
  try {
    await store.commit(accountId, [
      {
        kind: 'destroy',
        type: PUSH_SUBSCRIPTION,
        id: record.id,
        expectedVersion: record.version,
      },
    ]);
  } catch (error) {
    // Changed or removed by someone else in the meantime; leave it to them.
    if (!(error instanceof ConflictError)) throw error;
  }
}

/**
 * Tells an account's push subscriptions that data changed: each verified
 * subscription gets a StateChange object (RFC 8620 §7.1) with the current
 * state of the types it asked for. `types` limits this to the types that
 * changed; without it every pushed type is included.
 */
export async function pushStateChange(
  store: MetadataStore,
  push: ResolvedPushOptions,
  accountId: string,
  types?: readonly string[],
): Promise<PushReport> {
  const report: PushReport = { sent: 0, failed: 0, removed: 0 };
  const changedTypes = push.pushedTypes.filter(
    (type) => types === undefined || types.includes(type),
  );
  if (changedTypes.length === 0) return report;

  const records = (await store.list(
    accountId,
    PUSH_SUBSCRIPTION,
  )) as unknown as SubscriptionRecord[];
  if (records.length === 0) return report;

  const states = new Map<string, string>();
  await Promise.all(
    changedTypes.map(async (type) =>
      states.set(type, await store.getState(accountId, type)),
    ),
  );
  const now = push.now();

  await Promise.all(
    records.map(async (record) => {
      const { value } = record;
      if (isExpired(value, now)) {
        await destroyQuietly(store, accountId, record);
        report.removed += 1;
        return;
      }
      if (!isVerified(value)) return;
      if (value.pausedUntil && Date.parse(value.pausedUntil) > now.getTime()) {
        return;
      }
      const wanted = changedTypes.filter(
        (type) => value.types === null || value.types.includes(type),
      );
      if (wanted.length === 0) return;

      const outcome = await post(
        push,
        value,
        {
          '@type': 'StateChange',
          changed: {
            [accountId]: Object.fromEntries(
              wanted.map((type) => [type, states.get(type)]),
            ),
          },
        },
        record.id,
      );
      if (outcome.kind === 'sent') {
        report.sent += 1;
      } else if (outcome.kind === 'gone') {
        await destroyQuietly(store, accountId, record);
        report.removed += 1;
      } else {
        report.failed += 1;
        if (outcome.kind === 'paused') {
          const pausedUntil = toUtcDate(
            new Date(now.getTime() + outcome.seconds * 1000),
          );
          try {
            await store.commit(accountId, [
              {
                kind: 'update',
                type: PUSH_SUBSCRIPTION,
                id: record.id,
                value: { ...value, pausedUntil },
                expectedVersion: record.version,
              },
            ]);
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
          }
        }
      }
    }),
  );
  return report;
}

const GetArgumentsSchema = z.strictObject({
  ids: z.array(z.string()).nullish(),
  properties: z.array(z.string()).nullish(),
});

const SetArgumentsSchema = z.strictObject({
  create: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  update: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  destroy: z.array(z.string()).nullish(),
});

const CREATE_PROPERTIES = new Set([
  'deviceClientId',
  'url',
  'keys',
  'verificationCode',
  'expires',
  'types',
]);

async function liveRecords(
  ctx: MethodContext,
  push: ResolvedPushOptions,
  ids?: readonly string[],
): Promise<SubscriptionRecord[]> {
  const accountId = ctx.auth.accountId;
  const records = (ids === undefined
    ? await ctx.store.list(accountId, PUSH_SUBSCRIPTION)
    : await ctx.store.get(
        accountId,
        PUSH_SUBSCRIPTION,
        ids,
      )) as unknown as SubscriptionRecord[];
  // An expired subscription is as good as gone, whether or not it was cleaned up yet.
  const now = push.now();
  return records.filter((record) => !isExpired(record.value, now));
}

async function createSubscription(
  ctx: MethodContext,
  push: ResolvedPushOptions,
  input: Record<string, unknown>,
): Promise<{ id: string; expires: string }> {
  const unknown = Object.keys(input).filter(
    (property) => !CREATE_PROPERTIES.has(property),
  );
  if (unknown.length > 0) {
    throw new SetFailure('invalidProperties', undefined, {
      properties: unknown,
    });
  }

  const { deviceClientId, url, keys } = input;
  if (
    typeof deviceClientId !== 'string' ||
    deviceClientId.length === 0 ||
    deviceClientId.length > 255
  ) {
    throw invalid(
      'deviceClientId',
      'deviceClientId must be a string of 1 to 255 characters',
    );
  }
  let parsedUrl: URL | undefined;
  if (typeof url === 'string' && url.length <= MAX_URL_LENGTH) {
    try {
      parsedUrl = new URL(url);
    } catch {
      // Reported below.
    }
  }
  if (!parsedUrl || !push.allowUrl(parsedUrl)) {
    throw invalid('url', 'url must be an https URL of a public push service');
  }
  let pushKeys: PushKeys | null = null;
  if (keys !== null && keys !== undefined) {
    const candidate = keys as Record<string, unknown>;
    if (
      typeof keys !== 'object' ||
      typeof candidate['p256dh'] !== 'string' ||
      typeof candidate['auth'] !== 'string' ||
      !(await isUsablePushKeys(candidate as unknown as PushKeys))
    ) {
      throw invalid(
        'keys',
        'keys must hold a P-256 public key (p256dh) and a 16-byte secret (auth), in URL-safe base64',
      );
    }
    pushKeys = { p256dh: candidate['p256dh'], auth: candidate['auth'] };
  }
  if (
    input['verificationCode'] !== null &&
    input['verificationCode'] !== undefined
  ) {
    throw invalid(
      'verificationCode',
      'verificationCode cannot be set when creating a subscription',
    );
  }
  const expires = chooseExpiry(input['expires'], push);
  const types = parseTypes(input['types']);

  if ((await liveRecords(ctx, push)).length >= push.maxSubscriptions) {
    throw new SetFailure(
      'overQuota',
      `An account may have at most ${push.maxSubscriptions} push subscriptions`,
    );
  }

  const id = generateId('ps');
  const value: SubscriptionValue = {
    deviceClientId,
    url: parsedUrl.href,
    keys: pushKeys,
    code: generateId('pv'),
    verificationCode: null,
    expires,
    types,
  };
  await ctx.store.commit(ctx.auth.accountId, [
    { kind: 'create', type: PUSH_SUBSCRIPTION, id, value },
  ]);

  // Nothing else goes to this URL until the client proves it receives what is sent there.
  await post(push, value, {
    '@type': 'PushVerification',
    pushSubscriptionId: id,
    verificationCode: value.code,
  });
  return { id, expires };
}

async function updateSubscription(
  ctx: MethodContext,
  push: ResolvedPushOptions,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return retryOnConflict(async () => {
    const [record] = await liveRecords(ctx, push, [id]);
    if (!record) throw new SetFailure('notFound');

    const value: SubscriptionValue = { ...record.value };
    let serverSet: Record<string, unknown> | null = null;
    for (const [property, given] of Object.entries(patch)) {
      if (property === 'verificationCode') {
        if (given !== value.code) {
          throw invalid('verificationCode', 'The verification code is wrong');
        }
        value.verificationCode = value.code;
      } else if (property === 'expires') {
        value.expires = chooseExpiry(given, push);
        if (value.expires !== given) serverSet = { expires: value.expires };
      } else if (property === 'types') {
        value.types = parseTypes(given);
      } else {
        throw invalid(property, `${property} cannot be changed`);
      }
    }

    await ctx.store.commit(ctx.auth.accountId, [
      {
        kind: 'update',
        type: PUSH_SUBSCRIPTION,
        id,
        value,
        expectedVersion: record.version,
      },
    ]);
    return serverSet;
  });
}

async function destroySubscription(
  ctx: MethodContext,
  id: string,
): Promise<void> {
  await retryOnConflict(async () => {
    const [record] = await ctx.store.get(
      ctx.auth.accountId,
      PUSH_SUBSCRIPTION,
      [id],
    );
    if (!record) throw new SetFailure('notFound');
    await ctx.store.commit(ctx.auth.accountId, [
      {
        kind: 'destroy',
        type: PUSH_SUBSCRIPTION,
        id,
        expectedVersion: record.version,
      },
    ]);
  });
}

function toSetError(error: unknown): SetError {
  if (error instanceof SetFailure) return error.error;
  throw error;
}

function orNull<T extends object>(value: T): T | null {
  return Object.keys(value).length === 0 ? null : value;
}

/**
 * PushSubscription/get and /set (RFC 8620 §7.2). Unlike other types these
 * take no account id and have no state: a subscription belongs to the user.
 */
export function pushMethods(
  push: ResolvedPushOptions,
): Record<string, MethodHandler> {
  return {
    'PushSubscription/get': async (rawArgs, ctx) => {
      const { ids, properties } = parseArguments(GetArgumentsSchema, rawArgs);
      if (properties?.some((name) => name === 'url' || name === 'keys')) {
        throw new MethodError('forbidden', 'url and keys are never returned');
      }
      const selected = selectProperties(properties, VISIBLE_PROPERTIES);
      const unique = ids ? [...new Set(ids)] : undefined;
      if (unique && unique.length > ctx.limits.maxObjectsInGet) {
        throw new MethodError(
          'requestTooLarge',
          `At most ${ctx.limits.maxObjectsInGet} ids may be requested at once`,
        );
      }

      const records = await liveRecords(ctx, push, unique);
      const found = new Set(records.map((record) => record.id));
      return {
        list: records.map((record) =>
          pick({ id: record.id, ...record.value }, selected),
        ),
        notFound: (unique ?? []).filter((id) => !found.has(id)),
      };
    },

    'PushSubscription/set': async (rawArgs, ctx) => {
      const args = parseArguments(SetArgumentsSchema, rawArgs);
      const create = Object.entries(args.create ?? {});
      const update = Object.entries(args.update ?? {});
      const destroy = args.destroy ?? [];
      if (
        create.length + update.length + destroy.length >
        ctx.limits.maxObjectsInSet
      ) {
        throw new MethodError(
          'requestTooLarge',
          `At most ${ctx.limits.maxObjectsInSet} objects may be changed in one call`,
        );
      }

      const created: Record<string, Record<string, unknown>> = {};
      const updated: Record<string, Record<string, unknown> | null> = {};
      const destroyed: string[] = [];
      const notCreated: Record<string, SetError> = {};
      const notUpdated: Record<string, SetError> = {};
      const notDestroyed: Record<string, SetError> = {};
      const resolve = (id: string) =>
        id.startsWith('#') ? ctx.createdIds.get(id.slice(1)) : id;

      for (const [creationId, input] of create) {
        try {
          const result = await createSubscription(ctx, push, input);
          created[creationId] = result;
          ctx.createdIds.set(creationId, result.id);
        } catch (error) {
          notCreated[creationId] = toSetError(error);
        }
      }
      for (const [requestedId, patch] of update) {
        try {
          const id = resolve(requestedId);
          if (id === undefined) throw new SetFailure('notFound');
          if (destroy.includes(requestedId)) {
            throw new SetFailure('willDestroy');
          }
          updated[requestedId] = await updateSubscription(ctx, push, id, patch);
        } catch (error) {
          notUpdated[requestedId] = toSetError(error);
        }
      }
      for (const requestedId of destroy) {
        try {
          const id = resolve(requestedId);
          if (id === undefined) throw new SetFailure('notFound');
          await destroySubscription(ctx, id);
          destroyed.push(requestedId);
        } catch (error) {
          notDestroyed[requestedId] = toSetError(error);
        }
      }

      return {
        created: orNull(created),
        updated: orNull(updated),
        destroyed: destroyed.length === 0 ? null : destroyed,
        notCreated: orNull(notCreated),
        notUpdated: orNull(notUpdated),
        notDestroyed: orNull(notDestroyed),
      };
    },
  };
}

function refuse(
  keys: string[],
  type: string,
  description?: string,
): Record<string, SetError> | null {
  return keys.length === 0
    ? null
    : Object.fromEntries(
        keys.map((key) => [
          key,
          { type, ...(description ? { description } : {}) },
        ]),
      );
}

/**
 * The same two methods for a server that does not push. Clients ask about
 * subscriptions when setting up an account whether or not push is offered,
 * and "there are none, and none can be made" is an answer they can work with.
 */
export const pushMethodsWhenDisabled: Record<string, MethodHandler> = {
  'PushSubscription/get': async (rawArgs) => {
    const { ids } = parseArguments(GetArgumentsSchema, rawArgs);
    return { list: [], notFound: ids ?? [] };
  },
  'PushSubscription/set': async (rawArgs) => {
    const { create, update, destroy } = parseArguments(
      SetArgumentsSchema,
      rawArgs,
    );
    return {
      created: null,
      updated: null,
      destroyed: null,
      notCreated: refuse(
        Object.keys(create ?? {}),
        'forbidden',
        'Push notifications are not available on this server',
      ),
      notUpdated: refuse(Object.keys(update ?? {}), 'notFound'),
      notDestroyed: refuse(destroy ?? [], 'notFound'),
    };
  },
};
