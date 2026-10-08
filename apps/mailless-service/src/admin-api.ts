import { randomUUID } from 'node:crypto';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAdminApi } from '@mailless/admin-api';
import { DynamoDbDirectory } from '@mailless/directory-dynamodb';
import {
  createTokenVerifier,
  tokenVerifierOptionsFromEnvironment,
} from '@mailless/identity';
import { CognitoIdentityProvider } from '@mailless/identity-cognito';
import { createAppPasswordStore } from '@mailless/app-passwords';
import { storedUsage } from '@mailless/jmap-server';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { assets } from './admin/web-assets.gen.js';
import {
  createAdminWeb,
  webConfigurationFromEnvironment,
} from './admin/web.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const oidc = tokenVerifierOptionsFromEnvironment(process.env);
if (!oidc) throw new Error('Missing environment variable OIDC_ISSUER');

// The SDK reads AWS_ENDPOINT_URL_DYNAMODB itself, which is how tests point it at a local stand-in.
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const passkeyEnrolmentUrl = process.env['PASSKEY_ENROLMENT_URL'];
const metadata = new DynamoDbMetadataStore({
  client: dynamodb,
  tableName: required('TABLE_NAME'),
});
// Where to ask for a closed account's mail to be removed. Without it, nothing removes it.
const purgeQueueUrl = process.env['PURGE_QUEUE_URL'];
const sqs = purgeQueueUrl ? new SQSClient({}) : undefined;
// The same limit the JMAP API is given. Without one there is none.
const quotaOctets = Number(process.env['QUOTA_OCTETS'] ?? '');

const api = createAdminApi({
  directory: new DynamoDbDirectory({
    client: dynamodb,
    tableName: required('DIRECTORY_TABLE'),
  }),
  identity: new CognitoIdentityProvider({
    client: new CognitoIdentityProviderClient({}),
    userPoolId: required('USER_POOL_ID'),
  }),
  // App passwords live with the mail they open, so in the metadata table.
  appPasswords: createAppPasswordStore(metadata),
  // How full each mailbox is: the count the JMAP API keeps, and the limit it applies.
  usage: {
    usedOctets: (accountId) => storedUsage(metadata, accountId),
    limitOctets:
      Number.isSafeInteger(quotaOctets) && quotaOctets > 0 ? quotaOctets : null,
  },
  ...(sqs
    ? {
        requestPurge: async (accountId: string) => {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: purgeQueueUrl,
              MessageBody: JSON.stringify({ accountId }),
              // One account's requests are handed out one at a time, and
              // each is its own: asking twice is not asking once.
              MessageGroupId: accountId,
              MessageDeduplicationId: randomUUID(),
            }),
          );
        },
      }
    : {}),
  verifyToken: createTokenVerifier(oidc),
  adminRole: required('ADMIN_ROLE'),
  ...(passkeyEnrolmentUrl ? { passkeyEnrolmentUrl } : {}),
  // Who did what to which account: the record of every change. No address, password or secret is in it.
  audit: (entry) => console.log(JSON.stringify({ event: 'admin', ...entry })),
  onError: (error) =>
    console.error(
      JSON.stringify({
        event: 'admin-error',
        error: (error as { name?: string }).name ?? 'Error',
      }),
    ),
});

// The pages of the admin interface are part of this function's own bundle.
const web = createAdminWeb({
  assets,
  configuration: webConfigurationFromEnvironment(process.env),
  mountedAt: '/admin',
});

/**
 * The admin interface under /admin and its API under /admin/api, next to the
 * JMAP API. The pages are public; everything they do goes through the API.
 */
export const handler = handle(
  new Hono()
    .route('/admin/api', api)
    .route('/admin', web)
    .notFound((c) =>
      c.json({ error: 'notFound', message: 'There is nothing here' }, 404),
    ),
);
