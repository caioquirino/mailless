import { MethodError, type CoreCapability } from '@mailless/jmap-core';
import type { z } from 'zod';
import {
  ConflictError,
  StateMismatchError,
  type BlobStore,
  type MetadataStore,
  type WriteOp,
} from './storage.js';

/** Who is making the request. Authentication happens in the host, before the server is called. */
export interface AuthContext {
  accountId: string;
  username: string;
}

export interface MethodContext {
  auth: AuthContext;
  store: MetadataStore;
  blobs: BlobStore;
  limits: CoreCapability;
  /** Creation id to server id, shared by every call in one request. */
  createdIds: Map<string, string>;
  /** Set by `/set` when `ifInState` was given; attached to the next commit, then cleared. */
  pendingExpectedState?: { type: string; state: string };
}

export type MethodHandler = (
  args: Record<string, unknown>,
  ctx: MethodContext,
) => Promise<Record<string, unknown>>;

export interface MethodDefinition {
  /** The capability URN that must be in `using` for this method to be callable. */
  capability: string;
  handler: MethodHandler;
}

export function parseArguments<Schema extends z.ZodType>(
  schema: Schema,
  args: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.join('/') ?? '';
  throw new MethodError(
    'invalidArguments',
    `${path ? `${path}: ` : ''}${issue?.message ?? 'invalid arguments'}`,
  );
}

export function requireAccount(ctx: MethodContext, accountId: string): string {
  if (accountId !== ctx.auth.accountId) {
    throw new MethodError('accountNotFound');
  }
  return accountId;
}

/** Writes a batch, attaching the pending `ifInState` check to the first commit of a `/set` call. */
export async function commit(
  ctx: MethodContext,
  ops: readonly WriteOp[],
): Promise<void> {
  if (ops.length === 0) return;
  const pending = ctx.pendingExpectedState;
  try {
    await ctx.store.commit(
      ctx.auth.accountId,
      ops,
      pending ? { expectedStates: { [pending.type]: pending.state } } : {},
    );
  } catch (error) {
    if (error instanceof StateMismatchError) {
      throw new MethodError('stateMismatch');
    }
    throw error;
  }
  ctx.pendingExpectedState = undefined;
}

const MAX_ATTEMPTS = 20;
const MAX_BACKOFF_MS = 250;

/**
 * Re-runs a read-compute-write function when another writer got in between.
 * Waits a random, growing interval between attempts so competing writers spread out.
 */
export async function retryOnConflict<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      const ceiling = Math.min(MAX_BACKOFF_MS, 2 ** attempt);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * ceiling),
      );
    }
  }
}

export function generateId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return prefix + hex;
}

export function toUtcDate(date: Date): string {
  return date.toISOString().replace(/\.?0+Z$/, 'Z');
}
