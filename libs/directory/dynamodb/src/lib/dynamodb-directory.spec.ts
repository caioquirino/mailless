import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { describeDirectoryContract } from '@mailless/directory/testing';
import {
  directoryTableDefinition,
  DynamoDbDirectory,
} from './dynamodb-directory.js';

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

const prefix = `mailless-directory-test-${Date.now().toString(36)}`;
const tables: string[] = [];
const newDirectory = async () => {
  const tableName = `${prefix}-${tables.length}`;
  tables.push(tableName);
  await base.send(new CreateTableCommand(directoryTableDefinition(tableName)));
  return new DynamoDbDirectory({ client, tableName });
};

afterAll(async () => {
  await Promise.all(
    tables.map((TableName) =>
      base.send(new DeleteTableCommand({ TableName })).catch(() => undefined),
    ),
  );
});

describe.skipIf(!reachable)('DynamoDbDirectory', () => {
  describeDirectoryContract('DynamoDB', newDirectory);

  it('leaves no item behind when an account with much in it is deleted', async () => {
    const directory = await newDirectory();
    const TableName = tables.at(-1) as string;
    await directory.createAccount({ id: 'big' });
    await directory.createAccount({ id: 'other' });
    // More than one transaction's worth of items to remove.
    for (let index = 0; index < 60; index++) {
      await directory.addAddress('big', `a${index}@example.com`);
    }
    await directory.setShare('big', 'other', 'member');
    await directory.setShare('other', 'big', 'reader');

    await directory.deleteAccount('big');
    const { Items } = await client.send(
      new ScanCommand({ TableName, ConsistentRead: true }),
    );
    expect((Items ?? []).map((item) => `${item['pk']} ${item['sk']}`)).toEqual([
      'A#other #',
    ]);
  });
});
