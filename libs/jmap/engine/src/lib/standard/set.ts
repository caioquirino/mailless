import {
  MethodError,
  SetFailure,
  type SetError,
  type SetResponse,
} from '@mailless/jmap-core';
import { requireAccount, type MethodContext } from '../context.js';

export interface SetSpec {
  type: string;
  /** Creates one object and returns its id plus any other server-set properties. */
  create?(
    ctx: MethodContext,
    input: Record<string, unknown>,
  ): Promise<{ id: string } & Record<string, unknown>>;
  /** Applies a PatchObject; returns server-changed properties the client did not send, or null. */
  update?(
    ctx: MethodContext,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  destroy?(ctx: MethodContext, id: string): Promise<void>;
}

export interface SetArgumentsLike {
  accountId: string;
  ifInState?: string | null | undefined;
  create?: Record<string, Record<string, unknown>> | null | undefined;
  update?: Record<string, Record<string, unknown>> | null | undefined;
  destroy?: string[] | null | undefined;
}

function toSetError(error: unknown): SetError {
  if (error instanceof SetFailure) return error.error;
  throw error;
}

/** Resolves a `#creationId` reference to the id created earlier in the same request. */
export function resolveCreationReference(
  ctx: MethodContext,
  id: string,
): string | undefined {
  if (!id.startsWith('#')) return id;
  return ctx.createdIds.get(id.slice(1));
}

/** The creation ids of the same call that an object being created refers to. */
function referencedCreations(
  value: unknown,
  creationIds: ReadonlySet<string>,
  found: Set<string>,
): void {
  const note = (text: string) => {
    if (text.startsWith('#') && creationIds.has(text.slice(1))) {
      found.add(text.slice(1));
    }
  };
  if (typeof value === 'string') note(value);
  else if (Array.isArray(value)) {
    for (const item of value) referencedCreations(item, creationIds, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      // Ids are also used as keys, as in mailboxIds.
      note(key);
      referencedCreations(item, creationIds, found);
    }
  }
}

/**
 * Orders creations so that an object comes after the ones it refers to by
 * creation id (RFC 8620 §5.3), whatever order the client listed them in.
 * Objects that refer to each other in a circle keep their given order.
 */
function inReferenceOrder(
  create: Array<[string, Record<string, unknown>]>,
): Array<[string, Record<string, unknown>]> {
  const creationIds = new Set(create.map(([creationId]) => creationId));
  const ordered: Array<[string, Record<string, unknown>]> = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(create);
  const visit = (creationId: string) => {
    if (state.has(creationId)) return;
    state.set(creationId, 'visiting');
    const input = byId.get(creationId) as Record<string, unknown>;
    const references = new Set<string>();
    referencedCreations(input, creationIds, references);
    for (const reference of references) visit(reference);
    state.set(creationId, 'done');
    ordered.push([creationId, input]);
  };
  for (const [creationId] of create) visit(creationId);
  return ordered;
}

const NOT_SUPPORTED = (type: string, action: string) =>
  new SetFailure('forbidden', `${type} objects cannot be ${action}`);

/**
 * Generic `/set` (RFC 8620 §5.3). Each object is its own atomic unit: one
 * failing does not stop the others. Order is create, update, destroy.
 */
export async function standardSet(
  ctx: MethodContext,
  spec: SetSpec,
  args: SetArgumentsLike,
): Promise<SetResponse<Record<string, unknown>>> {
  const accountId = requireAccount(ctx, args.accountId);
  const create = inReferenceOrder(Object.entries(args.create ?? {}));
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

  const oldState = await ctx.store.getState(accountId, spec.type);
  if (args.ifInState !== null && args.ifInState !== undefined) {
    if (args.ifInState !== oldState) throw new MethodError('stateMismatch');
    ctx.pendingExpectedState = { type: spec.type, state: oldState };
  }

  const created: Record<string, Record<string, unknown>> = {};
  const updated: Record<string, Record<string, unknown> | null> = {};
  const destroyed: string[] = [];
  const notCreated: Record<string, SetError> = {};
  const notUpdated: Record<string, SetError> = {};
  const notDestroyed: Record<string, SetError> = {};

  try {
    for (const [creationId, input] of create) {
      try {
        if (!spec.create) throw NOT_SUPPORTED(spec.type, 'created');
        const result = await spec.create(ctx, input);
        created[creationId] = result;
        ctx.createdIds.set(creationId, result.id);
      } catch (error) {
        notCreated[creationId] = toSetError(error);
      }
    }

    for (const [requestedId, patch] of update) {
      try {
        const id = resolveCreationReference(ctx, requestedId);
        if (id === undefined) throw new SetFailure('notFound');
        if (destroy.includes(requestedId)) throw new SetFailure('willDestroy');
        if (!spec.update) throw NOT_SUPPORTED(spec.type, 'updated');
        updated[requestedId] = await spec.update(ctx, id, patch);
      } catch (error) {
        notUpdated[requestedId] = toSetError(error);
      }
    }

    for (const requestedId of destroy) {
      try {
        const id = resolveCreationReference(ctx, requestedId);
        if (id === undefined) throw new SetFailure('notFound');
        if (!spec.destroy) throw NOT_SUPPORTED(spec.type, 'destroyed');
        await spec.destroy(ctx, id);
        destroyed.push(requestedId);
      } catch (error) {
        notDestroyed[requestedId] = toSetError(error);
      }
    }
  } finally {
    ctx.pendingExpectedState = undefined;
  }

  const orNull = <T extends object>(value: T): T | null =>
    Object.keys(value).length === 0 ? null : value;

  return {
    accountId,
    oldState,
    newState: await ctx.store.getState(accountId, spec.type),
    created: orNull(created),
    updated: orNull(updated),
    destroyed: destroyed.length === 0 ? null : destroyed,
    notCreated: orNull(notCreated),
    notUpdated: orNull(notUpdated),
    notDestroyed: orNull(notDestroyed),
  };
}
