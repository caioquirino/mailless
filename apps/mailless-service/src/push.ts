import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { pushChanges } from './push/state-stream.js';
import { readVapidKeys } from './push/vapid-keys.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// The key pushes are signed with. The API makes it when the first session is
// read, which is before any app can have subscribed, so there being none yet
// means there is nothing to sign. Not being able to read it is a failure:
// carrying on without it would remove every subscription made for it.
const vapidParameter = process.env['VAPID_PARAMETER'];
const vapidKeys = vapidParameter
  ? await readVapidKeys({ ssm: new SSMClient({}), parameter: vapidParameter })
  : undefined;

const jmap = createJmapServer({
  storage: {
    metadata: new DynamoDbMetadataStore({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: required('TABLE_NAME'),
    }),
    // Pushing only reads metadata; the blob store is required by the interface.
    blobs: new S3BlobStore({
      client: new S3Client({}),
      bucket: required('BUCKET'),
      keyPrefix: process.env['BLOB_PREFIX'] ?? 'blobs/',
    }),
  },
  urls: jmapUrls(process.env['PUBLIC_URL'] ?? 'https://jmap.invalid'),
  push: vapidKeys
    ? { vapid: { ...vapidKeys, subject: required('VAPID_SUBJECT') } }
    : {},
});

/**
 * Receives the metadata table's change stream and tells each account's push
 * subscriptions what changed. An unreachable push service is counted, not
 * thrown: only a failure on our side makes the batch retry.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  await pushChanges(event, {
    jmap,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}
