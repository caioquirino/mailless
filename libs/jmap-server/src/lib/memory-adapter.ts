import {
  ConflictError,
  StateMismatchError,
  type BlobStore,
  type ChangeLogEntry,
  type CommitOptions,
  type IndexKeys,
  type IndexQuery,
  type JsonObject,
  type MetadataStore,
  type StorageAdapter,
  type StoredRecord,
  type WriteOp,
} from './storage.js';

interface Row {
  version: number;
  value: JsonObject;
  indexes: IndexKeys;
}

interface LogRow {
  seq: number;
  type: string;
  id: string;
  kind: ChangeLogEntry['kind'];
  changedProperties?: string[];
}

interface AccountData {
  seq: number;
  typeSeq: Map<string, number>;
  rows: Map<string, Map<string, Row>>;
  log: LogRow[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryMetadataStore implements MetadataStore {
  private readonly accounts = new Map<string, AccountData>();

  private account(accountId: string): AccountData {
    let account = this.accounts.get(accountId);
    if (!account) {
      account = { seq: 0, typeSeq: new Map(), rows: new Map(), log: [] };
      this.accounts.set(accountId, account);
    }
    return account;
  }

  private table(account: AccountData, type: string): Map<string, Row> {
    let table = account.rows.get(type);
    if (!table) {
      table = new Map();
      account.rows.set(type, table);
    }
    return table;
  }

  async getState(accountId: string, type: string): Promise<string> {
    return String(this.account(accountId).typeSeq.get(type) ?? 0);
  }

  async get(
    accountId: string,
    type: string,
    ids: readonly string[],
  ): Promise<StoredRecord[]> {
    const table = this.table(this.account(accountId), type);
    const records: StoredRecord[] = [];
    for (const id of new Set(ids)) {
      const row = table.get(id);
      if (row)
        records.push({ id, version: row.version, value: clone(row.value) });
    }
    return records;
  }

  async list(
    accountId: string,
    type: string,
    index?: IndexQuery,
  ): Promise<StoredRecord[]> {
    const table = this.table(this.account(accountId), type);
    const records: StoredRecord[] = [];
    for (const [id, row] of table) {
      if (index && !row.indexes[index.name]?.includes(index.value)) continue;
      records.push({ id, version: row.version, value: clone(row.value) });
    }
    return records;
  }

  async commit(
    accountId: string,
    ops: readonly WriteOp[],
    options: CommitOptions = {},
  ): Promise<void> {
    if (ops.length === 0) return;
    const account = this.account(accountId);

    for (const [type, expected] of Object.entries(
      options.expectedStates ?? {},
    )) {
      const actual = String(account.typeSeq.get(type) ?? 0);
      if (actual !== expected) {
        throw new StateMismatchError(
          `${type} is at state ${actual}, expected ${expected}`,
        );
      }
    }

    const seen = new Set<string>();
    for (const op of ops) {
      const key = `${op.type}\u0000${op.id}`;
      if (seen.has(key)) {
        throw new Error(`Two operations target ${op.type} ${op.id}`);
      }
      seen.add(key);

      const row = this.table(account, op.type).get(op.id);
      if (op.kind === 'create') {
        if (row) throw new ConflictError(`${op.type} ${op.id} already exists`);
      } else if (!row) {
        throw new ConflictError(`${op.type} ${op.id} does not exist`);
      } else if (
        op.kind !== 'increment' &&
        op.expectedVersion !== undefined &&
        op.expectedVersion !== row.version
      ) {
        throw new ConflictError(
          `${op.type} ${op.id} is at version ${row.version}, expected ${op.expectedVersion}`,
        );
      }
    }

    const seq = ++account.seq;
    for (const op of ops) {
      const table = this.table(account, op.type);
      account.typeSeq.set(op.type, seq);
      if (op.kind === 'create') {
        table.set(op.id, {
          version: 1,
          value: clone(op.value),
          indexes: clone(op.indexes ?? {}),
        });
        account.log.push({ seq, type: op.type, id: op.id, kind: 'created' });
      } else if (op.kind === 'update') {
        table.set(op.id, {
          version: op.expectedVersion + 1,
          value: clone(op.value),
          indexes: clone(op.indexes ?? {}),
        });
        account.log.push({
          seq,
          type: op.type,
          id: op.id,
          kind: 'updated',
          ...(op.changedProperties
            ? { changedProperties: [...op.changedProperties] }
            : {}),
        });
      } else if (op.kind === 'increment') {
        const row = table.get(op.id) as Row;
        for (const [property, delta] of Object.entries(op.deltas)) {
          const current = row.value[property];
          row.value[property] =
            (typeof current === 'number' ? current : 0) + delta;
        }
        row.version += 1;
        account.log.push({
          seq,
          type: op.type,
          id: op.id,
          kind: 'updated',
          changedProperties: Object.keys(op.deltas),
        });
      } else {
        table.delete(op.id);
        account.log.push({ seq, type: op.type, id: op.id, kind: 'destroyed' });
      }
    }
  }

  async getChanges(
    accountId: string,
    type: string,
    sinceState: string,
  ): Promise<ChangeLogEntry[] | null> {
    const account = this.account(accountId);
    if (!/^(0|[1-9][0-9]*)$/.test(sinceState)) return null;
    const since = Number(sinceState);
    if (since > (account.typeSeq.get(type) ?? 0)) return null;

    return account.log
      .filter((row) => row.type === type && row.seq > since)
      .map((row) => ({
        state: String(row.seq),
        id: row.id,
        kind: row.kind,
        ...(row.changedProperties
          ? { changedProperties: [...row.changedProperties] }
          : {}),
      }));
  }
}

export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  private key(accountId: string, blobId: string): string {
    return `${accountId}\u0000${blobId}`;
  }

  async put(
    accountId: string,
    blobId: string,
    data: Uint8Array,
  ): Promise<void> {
    this.blobs.set(this.key(accountId, blobId), data.slice());
  }

  async get(accountId: string, blobId: string): Promise<Uint8Array | null> {
    return this.blobs.get(this.key(accountId, blobId))?.slice() ?? null;
  }

  async delete(accountId: string, blobId: string): Promise<void> {
    this.blobs.delete(this.key(accountId, blobId));
  }
}

/** Non-persistent storage for tests, demos, and as the reference implementation of the contract. */
export class InMemoryStorageAdapter implements StorageAdapter {
  readonly metadata = new InMemoryMetadataStore();
  readonly blobs = new InMemoryBlobStore();
}
