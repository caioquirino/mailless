/**
 * The storage contract every backend implements. It is deliberately small:
 * versioned records, secondary-index lookups, an atomic batch write, and a
 * change log. All JMAP semantics (filters, sorting, counts, threading) live in
 * the server, not in adapters.
 */

export type JsonObject = Record<string, unknown>;

export interface StoredRecord<T = JsonObject> {
  id: string;
  /** Starts at 1 and increases by one on every update. */
  version: number;
  value: T;
}

/** Index name to the keys this record is listed under. */
export type IndexKeys = Record<string, string[]>;

export type WriteOp =
  | {
      kind: 'create';
      type: string;
      id: string;
      value: JsonObject;
      indexes?: IndexKeys;
    }
  | {
      kind: 'update';
      type: string;
      id: string;
      value: JsonObject;
      /** The write fails with ConflictError unless the stored version matches. */
      expectedVersion: number;
      indexes?: IndexKeys;
      /** Recorded in the change log; omit when the change is not limited to known properties. */
      changedProperties?: string[];
    }
  | {
      /**
       * Adds to numeric properties without a version check, so concurrent
       * writers never conflict on counters. The record must exist. Counts as
       * an update: the version increases and indexes are left as they are.
       */
      kind: 'increment';
      type: string;
      id: string;
      deltas: Record<string, number>;
    }
  | {
      kind: 'destroy';
      type: string;
      id: string;
      expectedVersion?: number;
    };

export interface CommitOptions {
  /** Data type to the state it must currently have, checked atomically with the write. */
  expectedStates?: Record<string, string>;
}

export interface ChangeLogEntry {
  /** The state of this data type once the commit containing this entry was applied. */
  state: string;
  id: string;
  kind: 'created' | 'updated' | 'destroyed';
  changedProperties?: string[];
}

export interface IndexQuery {
  name: string;
  value: string;
}

/**
 * Asked between the steps of a long removal. False means "stop here": what
 * was removed stays removed and the rest is left for another call.
 */
export type KeepGoing = () => boolean;

export interface MetadataStore {
  /** Opaque state string for a data type; a type that was never written has a stable initial state. */
  getState(accountId: string, type: string): Promise<string>;

  /** Records that exist among `ids`; missing ids are simply absent from the result. */
  get(
    accountId: string,
    type: string,
    ids: readonly string[],
  ): Promise<StoredRecord[]>;

  /** All records of a type, or only those listed under one index key. */
  list(
    accountId: string,
    type: string,
    index?: IndexQuery,
  ): Promise<StoredRecord[]>;

  /**
   * Applies every operation or none. All data types touched get the same new state.
   * Throws ConflictError on a version or existence mismatch and
   * StateMismatchError when `expectedStates` does not hold.
   */
  commit(
    accountId: string,
    ops: readonly WriteOp[],
    options?: CommitOptions,
  ): Promise<void>;

  /**
   * Change-log entries after `sinceState`, oldest first, or null when the
   * state is unknown or the log no longer reaches back that far.
   */
  getChanges(
    accountId: string,
    type: string,
    sinceState: string,
  ): Promise<ChangeLogEntry[] | null>;

  /**
   * Removes everything kept for an account: records, indexes, change log and
   * states. Meant for an account that is closed and no longer written to.
   * Returns false when `keepGoing` stopped it early; calling again carries on.
   */
  purge(accountId: string, keepGoing?: KeepGoing): Promise<boolean>;
}

export interface BlobStore {
  put(accountId: string, blobId: string, data: Uint8Array): Promise<void>;
  get(accountId: string, blobId: string): Promise<Uint8Array | null>;
  delete(accountId: string, blobId: string): Promise<void>;
  /**
   * Removes every blob of an account. Returns false when `keepGoing` stopped
   * it early; calling again carries on.
   */
  purge(accountId: string, keepGoing?: KeepGoing): Promise<boolean>;
}

export interface StorageAdapter {
  metadata: MetadataStore;
  blobs: BlobStore;
}

/** A record changed or (dis)appeared between read and write; callers re-read and retry. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class StateMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateMismatchError';
  }
}
