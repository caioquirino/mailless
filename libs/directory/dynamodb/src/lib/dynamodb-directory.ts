import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  DirectoryError,
  lookupForm,
  normaliseAddress,
  requireAccess,
  requireAccountId,
  requireName,
  requireStatus,
  wildcardFor,
  type Account,
  type AccountStatus,
  type Directory,
  type ShareAccess,
} from '@mailless/directory';

/*
 * One table with string keys `pk` and `sk`.
 *
 *   Account            pk = A#<account>      sk = #
 *   Address of account pk = A#<account>      sk = ADDR#<address>
 *   Share of account   pk = A#<account>      sk = SHARE#<user>
 *   Address lookup     pk = ADDR#<address>   sk = #
 *   Shared with user   pk = U#<user>         sk = SHARE#<account>
 *
 * Everything about an account is one query; an address is one read; so is
 * what is shared with a user. The lookup items are written in the same
 * transaction as the items they mirror.
 */

export interface DynamoDbDirectoryOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  now?: () => Date;
}

/** The `CreateTable` input for a directory table. */
export function directoryTableDefinition(
  tableName: string,
): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
  };
}

const ROOT = '#';
const ADDRESS = 'ADDR#';
const SHARE = 'SHARE#';
/** A transaction changes 100 items at most. */
const TRANSACTION_SIZE = 100;

const accountKey = (id: string) => ({ pk: `A#${id}`, sk: ROOT });
const addressKey = (id: string, address: string) => ({
  pk: `A#${id}`,
  sk: ADDRESS + address,
});
const lookupKey = (address: string) => ({ pk: ADDRESS + address, sk: ROOT });
const shareKey = (id: string, user: string) => ({
  pk: `A#${id}`,
  sk: SHARE + user,
});
const sharedWithKey = (user: string, id: string) => ({
  pk: `U#${user}`,
  sk: SHARE + id,
});

type Item = Record<string, unknown>;
type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

function toAccount(item: Item): Account {
  return {
    id: (item['pk'] as string).slice(2),
    name: (item['name'] as string | null | undefined) ?? null,
    status: item['status'] as AccountStatus,
    createdAt: item['createdAt'] as string,
  };
}

const isFailedCondition = (error: unknown) =>
  (error as { name?: string }).name === 'ConditionalCheckFailedException';

/** Which conditions of a transaction did not hold, by position; undefined for any other failure. */
function failedConditions(error: unknown): boolean[] | undefined {
  const candidate = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
  };
  if (candidate.name !== 'TransactionCanceledException') return undefined;
  return (candidate.CancellationReasons ?? []).map(
    (reason) => reason.Code === 'ConditionalCheckFailed',
  );
}

export class DynamoDbDirectory implements Directory {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => Date;

  constructor(options: DynamoDbDirectoryOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.now = options.now ?? (() => new Date());
  }

  private async get(key: Item): Promise<Item | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    return Item;
  }

  /** Every item of a partition whose sort key starts with a prefix. */
  private async query(pk: string, prefix = ''): Promise<Item[]> {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          // A key condition cannot be given an empty text to start with.
          ...(prefix === ''
            ? {
                KeyConditionExpression: 'pk = :pk',
                ExpressionAttributeValues: { ':pk': pk },
              }
            : {
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
                ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
              }),
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }

  private exists(id: string): Write {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: accountKey(id),
        ConditionExpression: 'attribute_exists(pk)',
      },
    };
  }

  private put(item: Item): Write {
    return { Put: { TableName: this.tableName, Item: item } };
  }

  private remove(key: Item): Write {
    return { Delete: { TableName: this.tableName, Key: key } };
  }

  async resolveAddress(address: string): Promise<string | undefined> {
    const exact = lookupForm(address);
    if (exact === undefined) return undefined;
    const found =
      (await this.get(lookupKey(exact))) ??
      (await this.get(lookupKey(wildcardFor(exact) as string)));
    return found?.['account'] as string | undefined;
  }

  async account(id: string): Promise<Account | undefined> {
    const item = await this.get(accountKey(id));
    return item ? toAccount(item) : undefined;
  }

  async addressesOf(accountId: string): Promise<string[]> {
    const items = await this.query(`A#${accountId}`, ADDRESS);
    return items
      .map((item) => (item['sk'] as string).slice(ADDRESS.length))
      .sort();
  }

  async sharedWith(user: string): Promise<Record<string, ShareAccess>> {
    const items = await this.query(`U#${user}`, SHARE);
    return Object.fromEntries(
      items.map((item) => [
        (item['sk'] as string).slice(SHARE.length),
        item['access'] as ShareAccess,
      ]),
    );
  }

  async listAccounts(): Promise<Account[]> {
    // A directory is small: reading all of it costs less than keeping a list of it would.
    const accounts: Account[] = [];
    let start: Item | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'begins_with(pk, :account) AND sk = :root',
          ExpressionAttributeValues: { ':account': 'A#', ':root': ROOT },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      accounts.push(...(page.Items ?? []).map(toAccount));
      start = page.LastEvaluatedKey;
    } while (start);
    return accounts.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async createAccount(input: {
    id: string;
    name?: string | null;
  }): Promise<Account> {
    const id = requireAccountId(input.id);
    const item = {
      ...accountKey(id),
      name: requireName(input.name),
      status: 'active',
      createdAt: this.now().toISOString(),
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (!isFailedCondition(error)) throw error;
      throw new DirectoryError('exists', `The account "${id}" already exists`);
    }
    return toAccount(item);
  }

  async updateAccount(
    id: string,
    changes: { name?: string | null; status?: AccountStatus },
  ): Promise<Account> {
    const set: string[] = [];
    const names: Record<string, string> = {};
    const values: Item = {};
    if (changes.name !== undefined) {
      set.push('#name = :name');
      names['#name'] = 'name';
      values[':name'] = requireName(changes.name);
    }
    if (changes.status !== undefined) {
      set.push('#status = :status');
      names['#status'] = 'status';
      values[':status'] = requireStatus(changes.status);
    }
    const missing = new DirectoryError(
      'notFound',
      `There is no account "${id}"`,
    );
    if (set.length === 0) {
      const account = await this.account(id);
      if (!account) throw missing;
      return account;
    }
    try {
      const { Attributes } = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: accountKey(id),
          UpdateExpression: `SET ${set.join(', ')}`,
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toAccount(Attributes as Item);
    } catch (error) {
      if (isFailedCondition(error)) throw missing;
      throw error;
    }
  }

  async deleteAccount(id: string): Promise<void> {
    const own = await this.query(`A#${id}`);
    if (!own.some((item) => item['sk'] === ROOT)) {
      throw new DirectoryError('notFound', `There is no account "${id}"`);
    }
    const sharedWithIt = await this.query(`U#${id}`, SHARE);

    const writes: Write[] = [];
    for (const item of own) {
      const sk = item['sk'] as string;
      if (sk === ROOT) continue;
      writes.push(this.remove({ pk: item['pk'], sk }));
      // Each of these has an item that mirrors it, kept elsewhere.
      if (sk.startsWith(ADDRESS)) {
        writes.push(this.remove(lookupKey(sk.slice(ADDRESS.length))));
      } else if (sk.startsWith(SHARE)) {
        writes.push(this.remove(sharedWithKey(sk.slice(SHARE.length), id)));
      }
    }
    for (const item of sharedWithIt) {
      const accountId = (item['sk'] as string).slice(SHARE.length);
      writes.push(this.remove(sharedWithKey(id, accountId)));
      writes.push(this.remove(shareKey(accountId, id)));
    }
    // The account itself goes last, so that a failure half-way leaves it there to delete again.
    writes.push(this.remove(accountKey(id)));
    for (let start = 0; start < writes.length; start += TRANSACTION_SIZE) {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: writes.slice(start, start + TRANSACTION_SIZE),
        }),
      );
    }
  }

  async addAddress(accountId: string, address: string): Promise<void> {
    const normalised = normaliseAddress(address);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            this.exists(accountId),
            {
              Put: {
                TableName: this.tableName,
                Item: { ...lookupKey(normalised), account: accountId },
                // Free, or this account's already.
                ConditionExpression:
                  'attribute_not_exists(pk) OR account = :account',
                ExpressionAttributeValues: { ':account': accountId },
              },
            },
            this.put(addressKey(accountId, normalised)),
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (!failed) throw error;
      if (failed[0]) {
        throw new DirectoryError(
          'notFound',
          `There is no account "${accountId}"`,
        );
      }
      throw new DirectoryError(
        'addressTaken',
        'The address already delivers to another account',
      );
    }
  }

  async removeAddress(accountId: string, address: string): Promise<boolean> {
    const normalised = lookupForm(address);
    if (normalised === undefined) return false;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.tableName,
                Key: lookupKey(normalised),
                ConditionExpression: 'account = :account',
                ExpressionAttributeValues: { ':account': accountId },
              },
            },
            this.remove(addressKey(accountId, normalised)),
          ],
        }),
      );
      return true;
    } catch (error) {
      if (failedConditions(error)) return false;
      throw error;
    }
  }

  async sharesOf(accountId: string): Promise<Record<string, ShareAccess>> {
    const items = await this.query(`A#${accountId}`, SHARE);
    return Object.fromEntries(
      items.map((item) => [
        (item['sk'] as string).slice(SHARE.length),
        item['access'] as ShareAccess,
      ]),
    );
  }

  async setShare(
    accountId: string,
    user: string,
    access: ShareAccess,
  ): Promise<void> {
    requireAccess(access);
    if (accountId === user) {
      // Checked after the accounts, so that an unknown account is reported as that.
      if (!(await this.account(accountId))) {
        throw new DirectoryError(
          'notFound',
          `There is no account "${accountId}"`,
        );
      }
      throw new DirectoryError(
        'invalid',
        'An account is its own user’s already',
      );
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            this.exists(accountId),
            this.exists(user),
            this.put({ ...shareKey(accountId, user), access }),
            this.put({ ...sharedWithKey(user, accountId), access }),
          ],
        }),
      );
    } catch (error) {
      const failed = failedConditions(error);
      if (!failed) throw error;
      throw new DirectoryError(
        'notFound',
        `There is no account "${failed[0] ? accountId : user}"`,
      );
    }
  }

  async removeShare(accountId: string, user: string): Promise<boolean> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.tableName,
                Key: shareKey(accountId, user),
                ConditionExpression: 'attribute_exists(pk)',
              },
            },
            this.remove(sharedWithKey(user, accountId)),
          ],
        }),
      );
      return true;
    } catch (error) {
      if (failedConditions(error)) return false;
      throw error;
    }
  }
}
