import { MethodError } from '@mailless/jmap-core';
import type { MethodContext } from '../context.js';
import type { StoredRecord } from '../storage.js';

export interface LoadedForGet {
  state: string;
  records: StoredRecord[];
  notFound: string[];
}

/** Shared front half of every `/get`: state, limit checks, loading, and the notFound list. */
export async function loadForGet(
  ctx: MethodContext,
  type: string,
  ids: readonly string[] | null | undefined,
): Promise<LoadedForGet> {
  const accountId = ctx.auth.accountId;
  // Read the state first: a client may then see data newer than the state, never older.
  const state = await ctx.store.getState(accountId, type);

  if (ids === null || ids === undefined) {
    const records = await ctx.store.list(accountId, type);
    if (records.length > ctx.limits.maxObjectsInGet) {
      throw new MethodError(
        'requestTooLarge',
        `There are more than ${ctx.limits.maxObjectsInGet} objects; request them by id`,
      );
    }
    return { state, records, notFound: [] };
  }

  const unique = [...new Set(ids)];
  if (unique.length > ctx.limits.maxObjectsInGet) {
    throw new MethodError(
      'requestTooLarge',
      `At most ${ctx.limits.maxObjectsInGet} ids may be requested at once`,
    );
  }

  const found = await ctx.store.get(accountId, type, unique);
  const byId = new Map(found.map((record) => [record.id, record]));
  const records: StoredRecord[] = [];
  const notFound: string[] = [];
  for (const id of unique) {
    const record = byId.get(id);
    if (record) records.push(record);
    else notFound.push(id);
  }
  return { state, records, notFound };
}

/** Validates a `properties` argument and returns the list to output; `id` is always included. */
export function selectProperties(
  requested: readonly string[] | null | undefined,
  valid: readonly string[],
  defaults: readonly string[] = valid,
): string[] {
  if (requested === null || requested === undefined) return [...defaults];
  for (const property of requested) {
    if (!valid.includes(property)) {
      throw new MethodError(
        'invalidArguments',
        `Unknown property "${property}"`,
      );
    }
  }
  return [...new Set(['id', ...requested])];
}

export function pick(
  object: Record<string, unknown>,
  properties: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const property of properties) {
    if (Object.prototype.hasOwnProperty.call(object, property)) {
      result[property] = object[property];
    }
  }
  return result;
}
