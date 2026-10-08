import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
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
import { createJmapServer } from '@mailless/jmap-server';
import {
  createAppPasswordStore,
  isAppPassword,
} from '@mailless/jmap-server/auth';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import { SesMailTransport } from '@mailless/transport-ses';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createAuthenticator } from './api/authenticator.js';
import { identitiesFor } from './api/identities.js';
import { createLambdaHttpHandler } from './api/lambda-http.js';
import { createAwsSendScheduler } from './api/send-scheduler.js';
import { parseAccountShares, sharedAccountsFor } from './api/shares.js';
import { parseMailboxMap, resolveAccount } from './ingest/recipients.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const bucket = required('BUCKET');
const userPoolId = required('USER_POOL_ID');
const clientId = required('USER_POOL_CLIENT_ID');
const downloadPrefix = process.env['DOWNLOAD_PREFIX'] ?? 'downloads/';
const DOWNLOAD_URL_SECONDS = 300;
const mailboxes = parseMailboxMap(process.env['MAILBOXES']);
// Display names for the From header, by account.
const accountNames = JSON.parse(process.env['ACCOUNT_NAMES'] ?? '{}') as Record<
  string,
  string
>;
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
const storage = {
  metadata: new DynamoDbMetadataStore({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName: required('TABLE_NAME'),
  }),
  blobs: new S3BlobStore({
    client: s3,
    bucket,
    keyPrefix: process.env['BLOB_PREFIX'] ?? 'blobs/',
  }),
};

const cognito = new CognitoIdentityProviderClient({});
const verifier = CognitoJwtVerifier.create({
  userPoolId,
  tokenUse: 'access',
  clientId,
});

/** Errors that mean "these credentials are not accepted", as opposed to a failure on our side. */
const REFUSALS = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
  'InvalidParameterException',
]);

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

const appPasswords = createAppPasswordStore(storage.metadata);
// Accounts more than one user may use, such as a shared mailbox.
const accountShares = parseAccountShares(process.env['ACCOUNT_SHARES']);

const authenticate = createAuthenticator({
  isAppPassword,
  appPasswordLogin: async (username, password) =>
    (await appPasswords.verify(username, password)) ? username : null,
  allowPasswordLogin: process.env['ALLOW_PASSWORD_SIGN_IN'] !== 'false',
  // Mail clients ask for an email address. Sign in as the account that address delivers to.
  resolveUsername: (username) =>
    username.includes('@')
      ? (resolveAccount(mailboxes, username) ?? username)
      : username,
  onFailure: (failure) =>
    console.log(JSON.stringify({ event: 'sign-in-failed', ...failure })),
  verifyAccessToken: async (token) => (await verifier.verify(token)).username,
  passwordLogin: async (username, password) => {
    try {
      const result = await cognito.send(
        new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: clientId,
          AuthParameters: { USERNAME: username, PASSWORD: password },
        }),
      );
      // A challenge (new password required, MFA) cannot be answered over Basic authentication.
      return result.AuthenticationResult?.AccessToken ?? null;
    } catch (error) {
      if (REFUSALS.has((error as { name?: string }).name ?? '')) return null;
      throw error;
    }
  },
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
        // Mail apps register where to be told of new mail. The push function does the telling.
        push: {},
        // An account may send from the addresses that deliver to it.
        identities: (auth) =>
          identitiesFor(mailboxes, auth.accountId, accountNames),
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
        const sharedAccounts = sharedAccountsFor(
          accountShares,
          auth.accountId,
          accountNames,
        );
        return Object.keys(sharedAccounts).length > 0
          ? { ...auth, sharedAccounts }
          : auth;
      },
      challenge: 'Basic realm="mailless", Bearer',
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
