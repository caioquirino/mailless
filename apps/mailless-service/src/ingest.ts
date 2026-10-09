import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import { SesMailTransport } from '@mailless/transport-ses';
import type { SESEvent } from 'aws-lambda';
import { identitiesFor } from './api/identities.js';
import { ingest, type InboundStore } from './ingest/ingest.js';
import { directoryFromEnvironment } from './directory.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const bucket = required('BUCKET');
const inboundPrefix = process.env['INBOUND_PREFIX'] ?? 'inbound/';
const publicUrl = process.env['PUBLIC_URL'] ?? 'https://jmap.invalid';
const configurationSetName = process.env['CONFIGURATION_SET'];

// The SDK reads AWS_ENDPOINT_URL_S3 and AWS_ENDPOINT_URL_DYNAMODB itself, which is how tests
// point these clients at local stand-ins.
const s3 = new S3Client({
  forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// Who has a mailbox and which addresses deliver to it.
const directory = directoryFromEnvironment(process.env, dynamodb);

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
  // Incoming mail may be due a vacation response, which is mail going out.
  transport: new SesMailTransport({
    client: new SESv2Client({}),
    ...(configurationSetName ? { configurationSetName } : {}),
  }),
  identities: async (auth) =>
    identitiesFor(
      auth.accountId,
      await directory.addressesOf(auth.accountId),
      (await directory.account(auth.accountId))?.name,
    ),
  // An answer to an invitation, or word that an event is off, that could not
  // be taken in. The kind of failure only: nothing of whose calendar or what event.
  onSchedulingError: (error) =>
    console.log(
      JSON.stringify({
        event: 'scheduling',
        error: (error as { name?: string }).name ?? 'Error',
      }),
    ),
  // The outcome only: who wrote, and to whom, stays out of the logs.
  onAutoReply: (outcome, error) => {
    if (outcome === 'disabled') return;
    console.log(
      JSON.stringify({
        event: 'auto-reply',
        outcome,
        ...(error === undefined
          ? {}
          : { error: (error as { name?: string }).name ?? 'Error' }),
      }),
    );
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
    resolveAccount: async (recipient) => {
      const accountId = await directory.resolveAddress(recipient);
      if (accountId === undefined) return undefined;
      // Mail still arrives for an account that is switched off, but not for one on its way out.
      const account = await directory.account(accountId);
      return account && account.status !== 'deleting' ? accountId : undefined;
    },
    log: (entry) => console.log(JSON.stringify(entry)),
  });
}
