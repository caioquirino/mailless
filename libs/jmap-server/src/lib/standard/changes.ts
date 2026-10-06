import {
  ChangesArgumentsSchema,
  MethodError,
  type ChangesResponse,
} from '@mailless/jmap-core';
import {
  parseArguments,
  requireAccount,
  type MethodContext,
} from '../context.js';
import type { ChangeLogEntry } from '../storage.js';

interface Tracked {
  first: ChangeLogEntry['kind'];
  last: ChangeLogEntry['kind'];
  /** Union of changed properties, or null once any update was not limited to known properties. */
  properties: Set<string> | null;
}

export interface ChangesResult extends ChangesResponse {
  /**
   * For each updated id, the properties that changed, or null when unknown.
   * Lets a type report `updatedProperties` (RFC 8621 §2.2).
   */
  updatedDetail: Map<string, string[] | null>;
}

function track(map: Map<string, Tracked>, entry: ChangeLogEntry): void {
  const existing = map.get(entry.id);
  const entryProperties =
    entry.kind === 'updated' && entry.changedProperties
      ? entry.changedProperties
      : null;

  if (!existing) {
    map.set(entry.id, {
      first: entry.kind,
      last: entry.kind,
      properties:
        entry.kind === 'updated' && entryProperties
          ? new Set(entryProperties)
          : null,
    });
    return;
  }

  existing.last = entry.kind;
  if (entry.kind === 'updated') {
    if (existing.properties && entryProperties) {
      for (const property of entryProperties) existing.properties.add(property);
    } else {
      existing.properties = null;
    }
  }
}

function summarise(map: Map<string, Tracked>): {
  created: string[];
  updated: string[];
  destroyed: string[];
  updatedDetail: Map<string, string[] | null>;
} {
  const created: string[] = [];
  const updated: string[] = [];
  const destroyed: string[] = [];
  const updatedDetail = new Map<string, string[] | null>();

  for (const [id, tracked] of map) {
    const existedBefore = tracked.first !== 'created';
    const existsAfter = tracked.last !== 'destroyed';
    if (!existedBefore && existsAfter) created.push(id);
    else if (existedBefore && !existsAfter) destroyed.push(id);
    else if (existedBefore && existsAfter) {
      updated.push(id);
      updatedDetail.set(
        id,
        tracked.first === 'updated' && tracked.properties
          ? [...tracked.properties]
          : null,
      );
    }
  }
  return { created, updated, destroyed, updatedDetail };
}

/** Generic `/changes` (RFC 8620 §5.2) over the adapter's change log. */
export async function standardChanges(
  ctx: MethodContext,
  type: string,
  rawArgs: unknown,
): Promise<ChangesResult> {
  const args = parseArguments(ChangesArgumentsSchema, rawArgs);
  const accountId = requireAccount(ctx, args.accountId);

  const entries = await ctx.store.getChanges(accountId, type, args.sinceState);
  if (entries === null) throw new MethodError('cannotCalculateChanges');

  const groups: ChangeLogEntry[][] = [];
  for (const entry of entries) {
    const current = groups[groups.length - 1];
    if (current && current[0]?.state === entry.state) current.push(entry);
    else groups.push([entry]);
  }

  let tracked = new Map<string, Tracked>();
  let newState = args.sinceState;
  let hasMoreChanges = false;
  const maxChanges = args.maxChanges ?? Infinity;

  for (const group of groups) {
    const next = new Map(
      [...tracked].map(([id, value]) => [
        id,
        {
          ...value,
          properties: value.properties ? new Set(value.properties) : null,
        },
      ]),
    );
    for (const entry of group) track(next, entry);

    const summary = summarise(next);
    const count =
      summary.created.length +
      summary.updated.length +
      summary.destroyed.length;
    if (count > maxChanges) {
      if (newState === args.sinceState) {
        throw new MethodError(
          'cannotCalculateChanges',
          'A single change set is larger than maxChanges',
        );
      }
      hasMoreChanges = true;
      break;
    }
    tracked = next;
    newState = (group[0] as ChangeLogEntry).state;
  }

  return {
    accountId,
    oldState: args.sinceState,
    newState,
    hasMoreChanges,
    ...summarise(tracked),
  };
}

/** Strips the internal detail so the result can be returned as a response. */
export function toChangesResponse(result: ChangesResult): ChangesResponse {
  return {
    accountId: result.accountId,
    oldState: result.oldState,
    newState: result.newState,
    hasMoreChanges: result.hasMoreChanges,
    created: result.created,
    updated: result.updated,
    destroyed: result.destroyed,
  };
}
