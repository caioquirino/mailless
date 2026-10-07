import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import type { SESEvent } from 'aws-lambda';
import { ingest, type InboundStore } from './ingest/ingest.js';
import { parseMailboxMap, resolveAccount } from './ingest/recipients.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const bucket = required('BUCKET');
const inboundPrefix = process.env['INBOUND_PREFIX'] ?? 'inbound/';
const publicUrl = process.env['PUBLIC_URL'] ?? 'https://jmap.invalid';
const mailboxes = parseMailboxMap(process.env['MAILBOXES']);

// The SDK reads AWS_ENDPOINT_URL_S3 and AWS_ENDPOINT_URL_DYNAMODB itself, which is how tests
// point these clients at local stand-ins.
const s3 = new S3Client({
  forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const jmap = createJmapServer({
  storage: {
    metadata: new DynamoDbMetadataStore({
      client: dynamodb,
      tableName: required('TABLE_NAME'),
    }),
    blobs: new S3BlobStore({
      client: s3,
      bucket,
      keyPrefix: process.env['BLOB_PREFIX'] ?? 'blobs/',
    }),
  },
  urls: {
    api: `${publicUrl}/jmap/api`,
    download: `${publicUrl}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    upload: `${publicUrl}/jmap/upload/{accountId}`,
    eventSource: `${publicUrl}/jmap/events?types={types}&closeafter={closeafter}&ping={ping}`,
  },
});

const inbound: InboundStore = {
  async get(messageId) {
    try {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: inboundPrefix + messageId,
        }),
      );
      return (await response.Body?.transformToByteArray()) ?? new Uint8Array();
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  },
  async delete(messageId) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: inboundPrefix + messageId,
      }),
    );
  },
};

export async function handler(event: SESEvent): Promise<void> {
  await ingest(event, {
    jmap,
    inbound,
    resolveAccount: (recipient) => resolveAccount(mailboxes, recipient),
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}
