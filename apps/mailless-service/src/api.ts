import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  createTokenVerifier,
  tokenVerifierOptionsFromEnvironment,
} from '@mailless/identity';
import { createJmapServer } from '@mailless/jmap-server';
import { createAppPasswordStore, isAppPassword } from '@mailless/app-passwords';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import { SesMailTransport } from '@mailless/transport-ses';
import { createAuthenticator } from './api/authenticator.js';
import { identitiesFor } from './api/identities.js';
import { createLambdaHttpHandler } from './api/lambda-http.js';
import { createAwsSendScheduler } from './api/send-scheduler.js';
import { sharedAccountsFor } from './api/shares.js';
import { directoryFromEnvironment } from './directory.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const bucket = required('BUCKET');
const downloadPrefix = process.env['DOWNLOAD_PREFIX'] ?? 'downloads/';
const DOWNLOAD_URL_SECONDS = 300;
const configurationSetName = process.env['CONFIGURATION_SET'];
const transport = new SesMailTransport({
  client: new SESv2Client({}),
  ...(configurationSetName ? { configurationSetName } : {}),
});

// The SDK reads AWS_ENDPOINT_URL_S3 and AWS_ENDPOINT_URL_DYNAMODB itself, which is how tests
// point these clients at local stand-ins.
const s3 = new S3Client({
  forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
});
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const storage = {
  metadata: new DynamoDbMetadataStore({
    client: dynamodb,
    tableName: required('TABLE_NAME'),
  }),
  blobs: new S3BlobStore({
    client: s3,
    bucket,
    keyPrefix: process.env['BLOB_PREFIX'] ?? 'blobs/',
  }),
};
// Who has a mailbox, which addresses deliver to it and who else may use it.
const directory = directoryFromEnvironment(process.env, dynamodb);

// Whose token it is. Any OpenID Connect provider will do: which claim says
// what is configuration, and nothing here knows which provider it is.
const oidc = tokenVerifierOptionsFromEnvironment(process.env);
if (!oidc) throw new Error('Missing environment variable OIDC_ISSUER');
const verifyToken = createTokenVerifier(oidc);

// Holding a message to send it later needs something to wake up for it. Without
// these settings, messages simply go at once.
const sendQueueUrl = process.env['SEND_QUEUE_URL'];
const scheduler = sendQueueUrl
  ? createAwsSendScheduler({
      sqs: new SQSClient({}),
      scheduler: new SchedulerClient({}),
      queueUrl: sendQueueUrl,
      scheduleGroup: required('SCHEDULE_GROUP'),
      functionArn: required('SEND_FUNCTION_ARN'),
      schedulerRoleArn: required('SCHEDULER_ROLE_ARN'),
      deadLetterQueueArn: required('SEND_DEAD_LETTER_QUEUE_ARN'),
    })
  : undefined;

// The limit on the mail an account may hold when it has none of its own, shown
// to clients as its quota. Without one, such an account has no limit.
const configuredQuota = Number(process.env['QUOTA_OCTETS'] ?? '');
const defaultQuotaOctets =
  Number.isSafeInteger(configuredQuota) && configuredQuota > 0
    ? configuredQuota
    : null;

const appPasswords = createAppPasswordStore(storage.metadata);

const authenticate = createAuthenticator({
  isAppPassword,
  appPasswordLogin: async (username, password) =>
    (await appPasswords.verify(username, password)) ? username : null,
  // Mail clients ask for an email address. Sign in as the account that address delivers to.
  resolveUsername: async (username) =>
    username.includes('@')
      ? ((await directory.resolveAddress(username)) ?? username)
      : username,
  onFailure: (failure) =>
    console.log(JSON.stringify({ event: 'sign-in-failed', ...failure })),
  verifyAccessToken: async (token) => (await verifyToken(token)).username,
});

export const handler = createLambdaHttpHandler({
  publicUrl: process.env['PUBLIC_URL'],
  createHandler: (baseUrl) =>
    createFetchHandler({
      server: createJmapServer({
        storage,
        urls: jmapUrls(baseUrl),
        // A Lambda invocation carries at most 6 MB, and binary uploads arrive base64-encoded.
        limits: { maxSizeRequest: 5_000_000, maxSizeUpload: 4_000_000 },
        transport,
        ...(scheduler ? { scheduler } : {}),
        // An account's own limit is set in the admin interface and kept in the directory.
        quota: {
          maxOctets: async (accountId) =>
            (await directory.account(accountId))?.quotaOctets ??
            defaultQuotaOctets,
        },
        // Mail apps register where to be told of new mail. The push function does the telling.
        push: {},
        // An account may send from the addresses that deliver to it.
        identities: async (auth) =>
          identitiesFor(
            auth.accountId,
            await directory.addressesOf(auth.accountId),
            (await directory.account(auth.accountId))?.name,
          ),
        onError: (error, method) =>
          console.error(JSON.stringify({ method, error: String(error) })),
        // What each request asked for and how it fared, by name only: this is how a
        // client's expectations show up without logging anyone's mail.
        onRequest: (summary) =>
          console.log(JSON.stringify({ event: 'request', ...summary })),
        // Method names and error types only; descriptions name properties, never values.
        onMethodError: (method, type, description) =>
          console.log(
            JSON.stringify({
              event: 'method-error',
              method,
              type,
              description,
            }),
          ),
      }),
      // Who someone is comes from the sign-in; what is shared with them, from configuration.
      authenticate: async (request) => {
        const auth = await authenticate(request);
        if (!auth) return null;
        // A sign-in proves who someone is. Whether they have a mailbox is the directory's to say.
        const account = await directory.account(auth.accountId);
        if (account?.status !== 'active') {
          console.log(
            JSON.stringify({
              event: 'sign-in-failed',
              reason: account ? 'account-not-active' : 'no-account',
            }),
          );
          return null;
        }
        const sharedAccounts = await sharedAccountsFor(
          directory,
          auth.accountId,
        );
        return Object.keys(sharedAccounts).length > 0
          ? { ...auth, sharedAccounts }
          : auth;
      },
      challenge: 'Basic realm="mailless", Bearer',
      // A request turned away whole runs no method, so it would otherwise leave no trace here.
      onRefused: (refusal) =>
        console.log(JSON.stringify({ event: 'request-refused', ...refusal })),
      onError: (error) =>
        console.error(JSON.stringify({ error: String(error) })),
    }),
  // Large downloads go through a private, short-lived object instead of the Lambda response.
  offload: async (body, headers) => {
    const key = `${downloadPrefix}${crypto.randomUUID()}${crypto.randomUUID()}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: headers.get('content-type') ?? 'application/octet-stream',
        ContentDisposition: headers.get('content-disposition') ?? 'attachment',
      }),
    );
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      {
        expiresIn: DOWNLOAD_URL_SECONDS,
      },
    );
  },
});
