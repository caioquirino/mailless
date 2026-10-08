import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAdminApi } from '@mailless/admin-api';
import { DynamoDbDirectory } from '@mailless/directory-dynamodb';
import {
  createTokenVerifier,
  tokenVerifierOptionsFromEnvironment,
} from '@mailless/identity';
import { CognitoIdentityProvider } from '@mailless/identity-cognito';
import { createAppPasswordStore } from '@mailless/jmap-server/auth';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';

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
  appPasswords: createAppPasswordStore(
    new DynamoDbMetadataStore({
      client: dynamodb,
      tableName: required('TABLE_NAME'),
    }),
  ),
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

/** The admin API, served under /admin/api next to the JMAP API. */
export const handler = handle(
  new Hono()
    .route('/admin/api', api)
    .notFound((c) =>
      c.json({ error: 'notFound', message: 'There is nothing here' }, 404),
    ),
);
