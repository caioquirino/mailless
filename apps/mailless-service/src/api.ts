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
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createJmapServer } from '@mailless/jmap-server';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createAuthenticator } from './api/authenticator.js';
import { createLambdaHttpHandler } from './api/lambda-http.js';

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

const authenticate = createAuthenticator({
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
        onError: (error, method) =>
          console.error(JSON.stringify({ method, error: String(error) })),
      }),
      authenticate,
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
