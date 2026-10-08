import { createHash } from 'node:crypto';
import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type BatchWriteCommandOutput,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  ConflictError,
  StateMismatchError,
  type ChangeLogEntry,
  type CommitOptions,
  type IndexKeys,
  type IndexQuery,
  type JsonObject,
  type KeepGoing,
  type MetadataStore,
  type StoredRecord,
  type WriteOp,
} from '@mailless/jmap-engine';

/*
 * Single-table layout. Every item has a string partition key `pk` and sort key `sk`.
 *
 *   Record   pk = R#<account>#<type>                 sk = <id>          v, d, x
 *   Index    pk = I#<account>#<type>#<name>#<value>  sk = <id>
 *   Log      pk = L#<account>#<type>                 sk = <seq>#<id>    k, p
 *   State    pk = S#<account>                        sk = <type>        seq
 *
 * `v` is the record version, `d` its value, `x` the index keys it is listed
 * under (needed to remove index items later). A data type's state is the
 * sequence number of the last commit that touched it.
 */

export interface DynamoDbMetadataStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

type TransactItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number];
type Key = { pk: string; sk: string };

interface RecordItem extends Key {
  v: number;
  d: JsonObject;
  x?: IndexKeys;
}

const MAX_TRANSACTION_ITEMS = 100;
const BATCH_GET_SIZE = 100;
const BATCH_WRITE_SIZE = 25;
const PURGE_PAGE_SIZE = 200;
const MAX_COMMIT_ATTEMPTS = 30;
const MAX_BACKOFF_MS = 200;
const MAX_INDEX_VALUE_BYTES = 512;
const SEQ_DIGITS = 16;
const STATE_PATTERN = /^(0|[1-9][0-9]*)$/;

const enc = encodeURIComponent;

/**
 * Partition keys of state items start with this. A state item is written by
 * every commit, so a table stream filtered on the prefix sees each change to
 * an account's data exactly once per data type.
 */
export const STATE_KEY_PREFIX = 'S#';

/**
 * Reads the account and data type from the key of a state item, as found in a
 * stream record. Returns null for the key of any other kind of item.
 */
export function parseStateKey(key: {
  pk?: string;
  sk?: string;
}): { accountId: string; type: string } | null {
  if (!key.pk?.startsWith(STATE_KEY_PREFIX) || !key.sk) return null;
  try {
    return {
      accountId: decodeURIComponent(key.pk.slice(STATE_KEY_PREFIX.length)),
      type: decodeURIComponent(key.sk),
    };
  } catch {
    return null;
  }
}

const recordPk = (account: string, type: string) =>
  `R#${enc(account)}#${enc(type)}`;
const logPk = (account: string, type: string) =>
  `L#${enc(account)}#${enc(type)}`;
const statePk = (account: string) => `${STATE_KEY_PREFIX}${enc(account)}`;
const padSeq = (seq: number) => String(seq).padStart(SEQ_DIGITS, '0');

function indexPk(
  account: string,
  type: string,
  name: string,
  value: string,
): string {
  // Long values (message ids can be) are hashed to stay well inside the key size limit.
  const key =
    Buffer.byteLength(value, 'utf8') > MAX_INDEX_VALUE_BYTES
      ? `h:${createHash('sha256').update(value).digest('hex')}`
      : `v:${enc(value)}`;
  return `I#${enc(account)}#${enc(type)}#${enc(name)}#${key}`;
}

function indexKeys(
  account: string,
  type: string,
  id: string,
  indexes: IndexKeys,
): Key[] {
  const keys = new Map<string, Key>();
  for (const [name, values] of Object.entries(indexes)) {
    for (const value of values) {
      const pk = indexPk(account, type, name, value);
      keys.set(pk, { pk, sk: id });
    }
  }
  return [...keys.values()];
}

function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toRecord(item: RecordItem): StoredRecord {
  return { id: item.sk, version: item.v, value: item.d };
}

function sleep(attempt: number): Promise<void> {
  const ceiling = Math.min(MAX_BACKOFF_MS, 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}

/** The table this store expects: string keys `pk` and `sk`, on-demand billing. */
export function tableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  };
}

export class DynamoDbMetadataStore implements MetadataStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoDbMetadataStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
  }

  private async batchGet(
    keys: readonly Key[],
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    for (let start = 0; start < keys.length; start += BATCH_GET_SIZE) {
      let pending: Key[] | undefined = keys.slice(
        start,
        start + BATCH_GET_SIZE,
      );
      for (let attempt = 1; pending && pending.length > 0; attempt++) {
        const response = await this.client.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: { Keys: pending, ConsistentRead: true },
            },
          }),
        );
        items.push(...(response.Responses?.[this.tableName] ?? []));
        pending = response.UnprocessedKeys?.[this.tableName]?.Keys as
          Key[] | undefined;
        if (pending && pending.length > 0) await sleep(attempt);
      }
    }
    return items;
  }

  private async queryAll(
    pk: string,
    fromSk?: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          KeyConditionExpression:
            fromSk === undefined ? '#pk = :pk' : '#pk = :pk AND #sk >= :sk',
          ExpressionAttributeNames:
            fromSk === undefined
              ? { '#pk': 'pk' }
              : { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues:
            fromSk === undefined ? { ':pk': pk } : { ':pk': pk, ':sk': fromSk },
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...(response.Items ?? []));
      startKey = response.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  private async readSeq(accountId: string, type: string): Promise<number> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: statePk(accountId), sk: enc(type) },
        ConsistentRead: true,
      }),
    );
    return (response.Item?.['seq'] as number | undefined) ?? 0;
  }

  async getState(accountId: string, type: string): Promise<string> {
    return String(await this.readSeq(accountId, type));
  }

  async get(
    accountId: string,
    type: string,
    ids: readonly string[],
  ): Promise<StoredRecord[]> {
    const pk = recordPk(accountId, type);
    const items = await this.batchGet(
      [...new Set(ids)].map((id) => ({ pk, sk: id })),
    );
    return (items as unknown as RecordItem[]).map(toRecord);
  }

  async list(
    accountId: string,
    type: string,
    index?: IndexQuery,
  ): Promise<StoredRecord[]> {
    if (!index) {
      const items = await this.queryAll(recordPk(accountId, type));
      return (items as unknown as RecordItem[]).map(toRecord);
    }
    const entries = await this.queryAll(
      indexPk(accountId, type, index.name, index.value),
    );
    return this.get(
      accountId,
      type,
      entries.map((entry) => entry['sk'] as string),
    );
  }

  async getChanges(
    accountId: string,
    type: string,
    sinceState: string,
  ): Promise<ChangeLogEntry[] | null> {
    if (!STATE_PATTERN.test(sinceState)) return null;
    const since = Number(sinceState);
    if (since > (await this.readSeq(accountId, type))) return null;

    const items = await this.queryAll(
      logPk(accountId, type),
      padSeq(since + 1),
    );
    return items.map((item) => {
      const sk = item['sk'] as string;
      const properties = item['p'] as string[] | undefined;
      return {
        state: String(Number(sk.slice(0, SEQ_DIGITS))),
        id: sk.slice(SEQ_DIGITS + 1),
        kind: item['k'] as ChangeLogEntry['kind'],
        ...(properties ? { changedProperties: properties } : {}),
      };
    });
  }

  async commit(
    accountId: string,
    ops: readonly WriteOp[],
    options: CommitOptions = {},
  ): Promise<void> {
    if (ops.length === 0) return;

    const seen = new Set<string>();
    for (const op of ops) {
      const key = `${op.type}\u0000${op.id}`;
      if (seen.has(key)) {
        throw new Error(`Two operations target ${op.type} ${op.id}`);
      }
      seen.add(key);
    }

    // Updates and destroys need the record's current index keys, and its version to guard them.
    const existing = new Map<string, RecordItem>();
    const toRead = ops
      .filter((op) => op.kind === 'update' || op.kind === 'destroy')
      .map((op) => ({ pk: recordPk(accountId, op.type), sk: op.id }));
    for (const item of (await this.batchGet(
      toRead,
    )) as unknown as RecordItem[]) {
      existing.set(`${item.pk}\u0000${item.sk}`, item);
    }
    const current = (op: WriteOp): RecordItem => {
      const item = existing.get(
        `${recordPk(accountId, op.type)}\u0000${op.id}`,
      );
      if (!item) throw new ConflictError(`${op.type} ${op.id} does not exist`);
      if (
        (op.kind === 'update' || op.kind === 'destroy') &&
        op.expectedVersion !== undefined &&
        op.expectedVersion !== item.v
      ) {
        throw new ConflictError(
          `${op.type} ${op.id} is at version ${item.v}, expected ${op.expectedVersion}`,
        );
      }
      return item;
    };
    for (const op of ops) {
      if (op.kind === 'update' || op.kind === 'destroy') current(op);
    }

    const types = [...new Set(ops.map((op) => op.type))];

    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
      const seqs = new Map<string, number>();
      for (const type of types)
        seqs.set(type, await this.readSeq(accountId, type));

      // Expected states of types this commit does not write are still checked inside the transaction.
      const untouched = new Map<string, number>();
      for (const [type, expected] of Object.entries(
        options.expectedStates ?? {},
      )) {
        const actualSeq =
          seqs.get(type) ?? (await this.readSeq(accountId, type));
        if (String(actualSeq) !== expected) {
          throw new StateMismatchError(
            `${type} is at state ${actualSeq}, expected ${expected}`,
          );
        }
        if (!seqs.has(type)) untouched.set(type, actualSeq);
      }

      const seq = Math.max(...seqs.values()) + 1;
      const { items, recordItemIndexes } = this.buildTransaction(
        accountId,
        ops,
        seq,
        seqs,
        untouched,
        current,
      );
      if (items.length > MAX_TRANSACTION_ITEMS) {
        throw new Error(
          `A commit needs ${items.length} DynamoDB writes; the limit is ${MAX_TRANSACTION_ITEMS}`,
        );
      }

      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: items }),
        );
        return;
      } catch (error) {
        const failure = error as {
          name?: string;
          CancellationReasons?: Array<{ Code?: string }>;
        };
        const retryable =
          failure.name === 'TransactionConflictException' ||
          failure.name === 'ProvisionedThroughputExceededException' ||
          failure.name === 'ThrottlingException';
        if (failure.name !== 'TransactionCanceledException' && !retryable) {
          throw error;
        }

        const reasons = failure.CancellationReasons ?? [];
        const recordCheckFailed = reasons.some(
          (reason, index) =>
            reason.Code === 'ConditionalCheckFailed' &&
            recordItemIndexes.has(index),
        );
        if (recordCheckFailed) {
          throw new ConflictError(
            'A record changed while the commit was in flight',
          );
        }
        const fatal = reasons.find(
          (reason) =>
            reason.Code !== undefined &&
            ![
              'None',
              'ConditionalCheckFailed',
              'TransactionConflict',
              'ThrottlingError',
              'ProvisionedThroughputExceeded',
            ].includes(reason.Code),
        );
        if (fatal) throw error;
        // Another commit moved a state forward, or collided with this one: take a new sequence number.
        await sleep(attempt);
      }
    }

    throw new ConflictError(
      `Could not commit after ${MAX_COMMIT_ATTEMPTS} attempts because of concurrent writes`,
    );
  }

  private buildTransaction(
    accountId: string,
    ops: readonly WriteOp[],
    seq: number,
    seqs: ReadonlyMap<string, number>,
    untouched: ReadonlyMap<string, number>,
    current: (op: WriteOp) => RecordItem,
  ): { items: TransactItem[]; recordItemIndexes: Set<number> } {
    const TableName = this.tableName;
    const items: TransactItem[] = [];
    const recordItemIndexes = new Set<number>();
    const pushRecord = (item: TransactItem) => {
      recordItemIndexes.add(items.length);
      items.push(item);
    };
    const log = (
      op: WriteOp,
      kind: ChangeLogEntry['kind'],
      changedProperties?: string[],
    ) => {
      items.push({
        Put: {
          TableName,
          Item: {
            pk: logPk(accountId, op.type),
            sk: `${padSeq(seq)}#${op.id}`,
            k: kind,
            ...(changedProperties ? { p: changedProperties } : {}),
          },
        },
      });
    };

    // Each touched type moves to the new sequence number only if no other commit got there first.
    for (const [type, currentSeq] of seqs) {
      items.push({
        Update: {
          TableName,
          Key: { pk: statePk(accountId), sk: enc(type) },
          UpdateExpression: 'SET #seq = :next',
          ConditionExpression:
            currentSeq === 0 ? 'attribute_not_exists(#seq)' : '#seq = :current',
          ExpressionAttributeNames: { '#seq': 'seq' },
          ExpressionAttributeValues:
            currentSeq === 0
              ? { ':next': seq }
              : { ':next': seq, ':current': currentSeq },
        },
      });
    }

    for (const [type, currentSeq] of untouched) {
      items.push({
        ConditionCheck: {
          TableName,
          Key: { pk: statePk(accountId), sk: enc(type) },
          ConditionExpression:
            currentSeq === 0 ? 'attribute_not_exists(#seq)' : '#seq = :current',
          ExpressionAttributeNames: { '#seq': 'seq' },
          ...(currentSeq === 0
            ? {}
            : { ExpressionAttributeValues: { ':current': currentSeq } }),
        },
      });
    }

    for (const op of ops) {
      const key = { pk: recordPk(accountId, op.type), sk: op.id };

      if (op.kind === 'create') {
        const indexes = plainJson(op.indexes ?? {});
        pushRecord({
          Put: {
            TableName,
            Item: { ...key, v: 1, d: plainJson(op.value), x: indexes },
            ConditionExpression: 'attribute_not_exists(#pk)',
            ExpressionAttributeNames: { '#pk': 'pk' },
          },
        });
        for (const Item of indexKeys(accountId, op.type, op.id, indexes)) {
          items.push({ Put: { TableName, Item } });
        }
        log(op, 'created');
      } else if (op.kind === 'update') {
        const previous = current(op);
        const indexes = plainJson(op.indexes ?? {});
        pushRecord({
          Put: {
            TableName,
            Item: {
              ...key,
              v: previous.v + 1,
              d: plainJson(op.value),
              x: indexes,
            },
            ConditionExpression: '#v = :version',
            ExpressionAttributeNames: { '#v': 'v' },
            ExpressionAttributeValues: { ':version': previous.v },
          },
        });
        const before = indexKeys(accountId, op.type, op.id, previous.x ?? {});
        const after = indexKeys(accountId, op.type, op.id, indexes);
        const afterPks = new Set(after.map((entry) => entry.pk));
        const beforePks = new Set(before.map((entry) => entry.pk));
        for (const Key of before) {
          if (!afterPks.has(Key.pk)) items.push({ Delete: { TableName, Key } });
        }
        for (const Item of after) {
          if (!beforePks.has(Item.pk)) items.push({ Put: { TableName, Item } });
        }
        log(op, 'updated', op.changedProperties);
      } else if (op.kind === 'increment') {
        const deltas = Object.entries(op.deltas);
        const names: Record<string, string> = { '#v': 'v', '#pk': 'pk' };
        const values: Record<string, number> = { ':one': 1 };
        if (deltas.length > 0) {
          names['#d'] = 'd';
          values[':zero'] = 0;
        }
        const sets = ['#v = #v + :one'];
        deltas.forEach(([property, delta], index) => {
          names[`#p${index}`] = property;
          values[`:d${index}`] = delta;
          sets.push(
            `#d.#p${index} = if_not_exists(#d.#p${index}, :zero) + :d${index}`,
          );
        });
        pushRecord({
          Update: {
            TableName,
            Key: key,
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          },
        });
        log(op, 'updated', Object.keys(op.deltas));
      } else {
        const previous = current(op);
        pushRecord({
          Delete: {
            TableName,
            Key: key,
            ConditionExpression: '#v = :version',
            ExpressionAttributeNames: { '#v': 'v' },
            ExpressionAttributeValues: { ':version': previous.v },
          },
        });
        for (const Key of indexKeys(
          accountId,
          op.type,
          op.id,
          previous.x ?? {},
        )) {
          items.push({ Delete: { TableName, Key } });
        }
        log(op, 'destroyed');
      }
    }

    return { items, recordItemIndexes };
  }

  private async batchDelete(keys: readonly Key[]): Promise<void> {
    for (let start = 0; start < keys.length; start += BATCH_WRITE_SIZE) {
      let pending: Record<string, unknown>[] | undefined = keys
        .slice(start, start + BATCH_WRITE_SIZE)
        .map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 1; pending && pending.length > 0; attempt++) {
        const response: BatchWriteCommandOutput = await this.client.send(
          new BatchWriteCommand({
            RequestItems: { [this.tableName]: pending },
          }),
        );
        pending = response.UnprocessedItems?.[this.tableName];
        if (pending && pending.length > 0) await sleep(attempt);
      }
    }
  }

  /**
   * Empties one partition a page at a time. `also` names further items that
   * go with an item of the partition. False when told to stop before the end.
   */
  private async emptyPartition(
    pk: string,
    keepGoing: KeepGoing | undefined,
    also: (item: Record<string, unknown>) => Key[] = () => [],
  ): Promise<boolean> {
    for (;;) {
      if (keepGoing && !keepGoing()) return false;
      // Always from the start: what the last round read is gone.
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': pk },
          Limit: PURGE_PAGE_SIZE,
        }),
      );
      const items = response.Items ?? [];
      if (items.length === 0 && !response.LastEvaluatedKey) return true;
      // What goes with an item first, so that an item is never gone while
      // something only it could name is still there.
      await this.batchDelete(items.flatMap(also));
      await this.batchDelete(
        items.map((item) => ({
          pk: item['pk'] as string,
          sk: item['sk'] as string,
        })),
      );
    }
  }

  /**
   * The state partition lists every data type the account ever wrote, which
   * is what makes this possible without reading the whole table. For each
   * type: the index items its records are listed under, the records, the
   * change log, and last the state item, so that a purge cut short still
   * knows the type when it is called again.
   */
  async purge(accountId: string, keepGoing?: KeepGoing): Promise<boolean> {
    const states = await this.queryAll(statePk(accountId));
    for (const state of states) {
      const encodedType = state['sk'] as string;
      const type = decodeURIComponent(encodedType);
      const records = await this.emptyPartition(
        recordPk(accountId, type),
        keepGoing,
        (item) =>
          indexKeys(
            accountId,
            type,
            item['sk'] as string,
            (item as unknown as RecordItem).x ?? {},
          ),
      );
      if (!records) return false;
      if (!(await this.emptyPartition(logPk(accountId, type), keepGoing))) {
        return false;
      }
      await this.batchDelete([{ pk: statePk(accountId), sk: encodedType }]);
    }
    return true;
  }
}
