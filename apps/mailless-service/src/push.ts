import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  createAwsAlertScheduler,
  isAlertWake,
  rescheduleAlerts,
  sendAlerts,
  type AlertWake,
} from './push/alerts.js';
import { arrivals } from './push/arrivals.js';
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
    // Pushing only reads metadata, what a notification says included; the blob store is required by the interface.
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

// Reminders are set where there is something to set them with: a stack that
// was not given it tells of changes as before, and reminds of nothing.
const scheduleGroup = process.env['SCHEDULE_GROUP'];
const alertScheduler = scheduleGroup
  ? createAwsAlertScheduler({
      scheduler: new SchedulerClient({}),
      scheduleGroup,
      functionArn: required('ALERTS_FUNCTION_ARN'),
      schedulerRoleArn: required('SCHEDULER_ROLE_ARN'),
      deadLetterQueueArn: required('ALERTS_DEAD_LETTER_QUEUE_ARN'),
    })
  : undefined;
const log = (entry: Record<string, unknown>) =>
  console.log(JSON.stringify(entry));

/**
 * Receives the metadata table's change stream and tells each account's push
 * subscriptions what changed. An unreachable push service is counted, not
 * thrown: only a failure on our side makes the batch retry.
 *
 * It is also what an account's reminders wake: then it tells the account's
 * devices which have come due.
 */
export async function handler(
  event: DynamoDBStreamEvent | AlertWake,
): Promise<void> {
  if (isAlertWake(event)) {
    if (alertScheduler) {
      await sendAlerts(event, { jmap, scheduler: alertScheduler, log });
    }
    return;
  }
  await pushChanges(event, {
    jmap,
    arrived: (accountId) => arrivals(jmap, accountId),
    ...(alertScheduler
      ? {
          calendarChanged: (accountId: string) =>
            rescheduleAlerts(accountId, { jmap, scheduler: alertScheduler }),
        }
      : {}),
    log,
  });
}
