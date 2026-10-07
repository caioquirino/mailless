import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { pushChanges } from './push/state-stream.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

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
  push: {},
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
