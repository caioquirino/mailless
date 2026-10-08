import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbDirectory } from '@mailless/directory-dynamodb';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import { purgeAccounts, type PurgeEvent } from './purge/purge-account.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** Stop starting new steps this long before the function is cut off. */
const MARGIN_MS = 60_000;

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const queueUrl = required('PURGE_QUEUE_URL');
// Not the cached reader the other functions use: what is asked here is
// whether an account is closed right now.
const directory = new DynamoDbDirectory({
  client: dynamodb,
  tableName: required('DIRECTORY_TABLE'),
});
const storage = {
  metadata: new DynamoDbMetadataStore({
    client: dynamodb,
    tableName: required('TABLE_NAME'),
  }),
  blobs: new S3BlobStore({
    client: new S3Client({
      forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
    }),
    bucket: required('BUCKET'),
    keyPrefix: process.env['BLOB_PREFIX'] ?? 'blobs/',
  }),
};

/**
 * Woken by a message naming an account that was closed, and removes its mail.
 * A mailbox too large for one run puts a message back for the next.
 */
export async function handler(
  event: PurgeEvent,
  context?: { getRemainingTimeInMillis?(): number },
): Promise<void> {
  await purgeAccounts(event, {
    directory,
    storage,
    keepGoing: () =>
      (context?.getRemainingTimeInMillis?.() ?? Infinity) > MARGIN_MS,
    continueLater: async (accountId) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ accountId }),
          MessageGroupId: accountId,
          MessageDeduplicationId: randomUUID(),
        }),
      );
    },
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}
