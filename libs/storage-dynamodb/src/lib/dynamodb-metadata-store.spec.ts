import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { InMemoryBlobStore } from '@mailless/jmap-server/memory';
import {
  describeJmapConformance,
  describeStorageContract,
} from '@mailless/jmap-server/testing';
import {
  DynamoDbMetadataStore,
  tableDefinition,
} from './dynamodb-metadata-store.js';

// Needs DynamoDB Local: `docker compose up -d` at the workspace root.
const endpoint = process.env['DYNAMODB_ENDPOINT'] ?? 'http://127.0.0.1:8000';
const base = new DynamoDBClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const client = DynamoDBDocumentClient.from(base);

let reachable = true;
try {
  await base.send(new ListTablesCommand({ Limit: 1 }));
} catch (error) {
  reachable = false;
  if (process.env['REQUIRE_LOCAL_SERVICES']) throw error;
  console.warn(`Skipping DynamoDB tests: nothing reachable at ${endpoint}`);
}

const prefix = `mailless-test-${Date.now().toString(36)}`;
const tables: string[] = [];
const newTable = async () => {
  const tableName = `${prefix}-${tables.length}`;
  tables.push(tableName);
  await base.send(new CreateTableCommand(tableDefinition(tableName)));
  return tableName;
};
const factory = async () => ({
  metadata: new DynamoDbMetadataStore({ client, tableName: await newTable() }),
  blobs: new InMemoryBlobStore(),
});

afterAll(async () => {
  await Promise.all(
    tables.map((TableName) =>
      base.send(new DeleteTableCommand({ TableName })).catch(() => undefined),
    ),
  );
});

describe.skipIf(!reachable)('DynamoDbMetadataStore', () => {
  describeStorageContract('DynamoDB metadata', factory);
  describeJmapConformance('DynamoDB metadata', factory);

  const itemsOf = async (tableName: string) =>
    (await client.send(new ScanCommand({ TableName: tableName }))).Items ?? [];

  it('removes index and record items when a record is destroyed', async () => {
    const tableName = await newTable();
    const store = new DynamoDbMetadataStore({ client, tableName });
    await store.commit('acc', [
      {
        kind: 'create',
        type: 'Note',
        id: 'a',
        value: { text: 'x' },
        indexes: { folder: ['inbox', 'work'], long: ['v'.repeat(2000)] },
      },
    ]);
    const kinds = (items: Record<string, unknown>[]) =>
      items
        .map((item) => (item['pk'] as string)[0])
        .sort()
        .join('');
    expect(kinds(await itemsOf(tableName))).toBe('IIILRS');
    expect(
      await store.list('acc', 'Note', {
        name: 'long',
        value: 'v'.repeat(2000),
      }),
    ).toHaveLength(1);

    await store.commit('acc', [{ kind: 'destroy', type: 'Note', id: 'a' }]);
    expect(kinds(await itemsOf(tableName))).toBe('LLS');
  });

  it('keeps account ids containing separators apart', async () => {
    const tableName = await newTable();
    const store = new DynamoDbMetadataStore({ client, tableName });
    await store.commit('a#b', [
      { kind: 'create', type: 'c', id: '1', value: {} },
    ]);
    expect(await store.list('a', 'b#c')).toEqual([]);
    expect(await store.list('a#b', 'c')).toHaveLength(1);
  });

  it('reads more records than one batch holds', async () => {
    const tableName = await newTable();
    const store = new DynamoDbMetadataStore({ client, tableName });
    const ids = Array.from({ length: 230 }, (_, index) => `n${index}`);
    for (let start = 0; start < ids.length; start += 30) {
      await store.commit(
        'acc',
        ids.slice(start, start + 30).map((id) => ({
          kind: 'create' as const,
          type: 'Note',
          id,
          value: { id },
          indexes: { all: ['yes'] },
        })),
      );
    }
    expect(await store.get('acc', 'Note', ids)).toHaveLength(230);
    expect(await store.list('acc', 'Note')).toHaveLength(230);
    expect(
      await store.list('acc', 'Note', { name: 'all', value: 'yes' }),
    ).toHaveLength(230);
  });

  it('rejects a commit that needs too many writes', async () => {
    const tableName = await newTable();
    const store = new DynamoDbMetadataStore({ client, tableName });
    await expect(
      store.commit(
        'acc',
        Array.from({ length: 60 }, (_, index) => ({
          kind: 'create' as const,
          type: 'Note',
          id: `n${index}`,
          value: {},
        })),
      ),
    ).rejects.toThrow(/limit is 100/);
    expect(await store.list('acc', 'Note')).toEqual([]);
  });
});
