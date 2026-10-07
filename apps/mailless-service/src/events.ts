import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import type { SNSEvent } from 'aws-lambda';
import {
  handleDeliveryEvent,
  type SesSendingEvent,
} from './events/delivery-events.js';

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
    // Delivery events only touch metadata; the blob store is required by the interface.
    blobs: new S3BlobStore({
      client: new S3Client({}),
      bucket: required('BUCKET'),
      keyPrefix: process.env['BLOB_PREFIX'] ?? 'blobs/',
    }),
  },
  urls: jmapUrls(process.env['PUBLIC_URL'] ?? 'https://jmap.invalid'),
});

/** Receives SES sending events (delivery, bounce, complaint, delay, reject) through SNS. */
export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    let parsed: SesSendingEvent;
    try {
      parsed = JSON.parse(record.Sns.Message) as SesSendingEvent;
    } catch {
      console.log(
        JSON.stringify({
          outcome: 'unparseable',
          snsMessageId: record.Sns.MessageId,
        }),
      );
      continue;
    }
    await handleDeliveryEvent(parsed, {
      jmap,
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  }
}
