import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import { SesMailTransport } from '@mailless/transport-ses';
import {
  sendScheduled,
  type ScheduledSendEvent,
} from './send/scheduled-send.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const configurationSetName = process.env['CONFIGURATION_SET'];
const jmap = createJmapServer({
  storage: {
    metadata: new DynamoDbMetadataStore({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName: required('TABLE_NAME'),
    }),
    blobs: new S3BlobStore({
      client: new S3Client({
        forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
      }),
      bucket: required('BUCKET'),
      keyPrefix: process.env['BLOB_PREFIX'] ?? 'blobs/',
    }),
  },
  urls: jmapUrls(process.env['PUBLIC_URL'] ?? 'https://jmap.invalid'),
  transport: new SesMailTransport({
    client: new SESv2Client({}),
    ...(configurationSetName ? { configurationSetName } : {}),
  }),
});

/**
 * Woken when a held message is due, by a delayed queue message or a one-time
 * schedule, and sends it. The message was checked when it was submitted;
 * nothing about who may send is decided here.
 */
export async function handler(event: ScheduledSendEvent): Promise<void> {
  await sendScheduled(event, {
    jmap,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}
