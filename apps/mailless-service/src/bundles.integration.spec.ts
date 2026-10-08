import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createJmapServer } from '@mailless/jmap-server';
import { createAppPasswordStore } from '@mailless/jmap-server/auth';
import { InMemoryBlobStore } from '@mailless/jmap-server/memory';
import { buildMessage } from '@mailless/jmap-server/testing';
import {
  DynamoDbMetadataStore,
  tableDefinition,
} from '@mailless/storage-dynamodb';
import { S3BlobStore } from '@mailless/storage-s3';
import type { SESEvent } from 'aws-lambda';

// Runs the built Lambda bundle against DynamoDB Local and an S3 stand-in:
// `docker compose up -d` at the workspace root.
const dynamoEndpoint =
  process.env['DYNAMODB_ENDPOINT'] ?? 'http://127.0.0.1:8000';
const s3Endpoint = process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9090';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const run = Date.now().toString(36);
const tableName = `mailless-ingest-${run}`;
const bucket = `mailless-ingest-${run}`;

const dynamo = new DynamoDBClient({
  endpoint: dynamoEndpoint,
  region: 'us-east-1',
  credentials,
});
const s3 = new S3Client({
  endpoint: s3Endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials,
});

let reachable = true;
try {
  await dynamo.send(new CreateTableCommand(tableDefinition(tableName)));
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
} catch (error) {
  reachable = false;
  if (process.env['REQUIRE_LOCAL_SERVICES']) throw error;
  console.warn(
    'Skipping ingest integration test: local services are not reachable',
  );
}

afterAll(async () => {
  await dynamo
    .send(new DeleteTableCommand({ TableName: tableName }))
    .catch(() => undefined);
});

describe.skipIf(!reachable)('API Lambda bundle', () => {
  it('loads and refuses unauthenticated requests on every route', async () => {
    Object.assign(process.env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,
      AWS_ENDPOINT_URL_S3: s3Endpoint,
      S3_FORCE_PATH_STYLE: 'true',
      TABLE_NAME: tableName,
      BUCKET: bucket,
      USER_POOL_ID: 'us-east-1_Example00',
      USER_POOL_CLIENT_ID: 'exampleclientid',
      PUBLIC_URL: 'https://mail.example.com',
    });
    const bundle = new URL('../dist/api.mjs', import.meta.url).href;
    const { handler } = (await import(
      /* @vite-ignore */ bundle
    )) as typeof import('./api.js');

    const call = (method: string, rawPath: string) =>
      handler({
        rawPath,
        rawQueryString: '',
        headers: {},
        isBase64Encoded: false,
        requestContext: { domainName: 'internal', http: { method } },
      } as unknown as Parameters<typeof handler>[0]);

    for (const [method, path] of [
      ['GET', '/.well-known/jmap'],
      ['POST', '/jmap/api'],
      ['POST', '/jmap/upload/acc-1'],
      ['GET', '/jmap/download/acc-1/blob/name'],
    ] as const) {
      const result = await call(method, path);
      expect(result.statusCode, path).toBe(401);
      expect(result.headers?.['www-authenticate']).toBe(
        'Basic realm="mailless", Bearer',
      );
    }
    expect((await call('GET', '/elsewhere')).statusCode).toBe(404);
  });

  it('signs in with an app password, by address, without the identity provider', async () => {
    const bundle = new URL('../dist/api.mjs', import.meta.url).href;
    const { handler } = (await import(
      /* @vite-ignore */ bundle
    )) as typeof import('./api.js');
    const passwords = createAppPasswordStore(
      new DynamoDbMetadataStore({
        client: DynamoDBDocumentClient.from(dynamo),
        tableName,
      }),
    );
    const { id, secret } = await passwords.create('acc-1', 'Integration test');

    const session = (username: string, password: string) =>
      handler({
        rawPath: '/.well-known/jmap',
        rawQueryString: '',
        headers: {
          authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        },
        isBase64Encoded: false,
        requestContext: { domainName: 'internal', http: { method: 'GET' } },
      } as unknown as Parameters<typeof handler>[0]);

    const accepted = await session('acc-1', secret);
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.body as string).username).toBe('acc-1');

    const wrong = `${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`;
    expect((await session('acc-1', wrong)).statusCode).toBe(401);
    expect((await session('someone-else', secret)).statusCode).toBe(401);

    // A different spelling of the same secret is a fresh check, so revocation is seen at once.
    await passwords.revoke('acc-1', id);
    expect((await session('acc-1', secret.toUpperCase())).statusCode).toBe(401);
  });
});

describe.skipIf(!reachable)('delivery events Lambda bundle', () => {
  it('loads and skips events it cannot use', async () => {
    Object.assign(process.env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,
      AWS_ENDPOINT_URL_S3: s3Endpoint,
      TABLE_NAME: tableName,
      BUCKET: bucket,
    });
    const bundle = new URL('../dist/events.mjs', import.meta.url).href;
    const { handler } = (await import(
      /* @vite-ignore */ bundle
    )) as typeof import('./events.js');

    const sns = (message: string) =>
      ({
        Records: [{ Sns: { Message: message, MessageId: 'sns-1' } }],
      }) as unknown as Parameters<typeof handler>[0];
    await expect(handler(sns('not json'))).resolves.toBeUndefined();
    await expect(
      handler(sns(JSON.stringify({ eventType: 'Send' }))),
    ).resolves.toBeUndefined();
    // A tracked event for a submission that does not exist reaches DynamoDB and is skipped.
    await expect(
      handler(
        sns(
          JSON.stringify({
            eventType: 'Delivery',
            mail: {
              messageId: 'm',
              tags: { account: ['acc-1'], submission: ['es-missing'] },
            },
            delivery: { recipients: ['a@example.org'] },
          }),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!reachable)('scheduled send Lambda bundle', () => {
  it('loads, and finds nothing to send for a message it does not know', async () => {
    Object.assign(process.env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,
      AWS_ENDPOINT_URL_S3: s3Endpoint,
      S3_FORCE_PATH_STYLE: 'true',
      TABLE_NAME: tableName,
      BUCKET: bucket,
    });
    const bundle = new URL('../dist/send.mjs', import.meta.url).href;
    const { handler } = (await import(
      /* @vite-ignore */ bundle
    )) as typeof import('./send.js');

    // As a schedule delivers it, and as the queue does.
    await expect(
      handler({ accountId: 'acc-1', submissionId: 'es-unknown' }),
    ).resolves.toBeUndefined();
    await expect(
      handler({
        Records: [
          { body: '{"accountId":"acc-1","submissionId":"es-unknown"}' },
          { body: 'not json' },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!reachable)('push Lambda bundle', () => {
  it('tells a verified subscription what changed, from a stream record', async () => {
    Object.assign(process.env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,
      AWS_ENDPOINT_URL_S3: s3Endpoint,
      TABLE_NAME: tableName,
      BUCKET: bucket,
    });

    // A stand-in push service on this machine.
    const received: Array<Record<string, unknown>> = [];
    const pushService = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) =>
      pushService.listen(0, '127.0.0.1', resolve),
    );
    const { port } = pushService.address() as AddressInfo;

    try {
      // Subscribe through a server that accepts a local URL; the deployed one would refuse it.
      const account = { accountId: 'acc-push', username: 'push@example.com' };
      const jmap = createJmapServer({
        storage: {
          metadata: new DynamoDbMetadataStore({
            client: DynamoDBDocumentClient.from(dynamo),
            tableName,
          }),
          // Kept out of the bucket, which another test counts the objects of.
          blobs: new InMemoryBlobStore(),
        },
        urls: { api: 'x', download: 'x', upload: 'x', eventSource: 'x' },
        push: { allowUrl: () => true },
      });
      const set = async (args: Record<string, unknown>) =>
        (
          await jmap.handleRequest(
            {
              using: ['urn:ietf:params:jmap:core'],
              methodCalls: [['PushSubscription/set', args, 'c']],
            },
            account,
          )
        ).methodResponses[0]?.[1] as Record<string, never>;
      const created = await set({
        create: {
          s: {
            deviceClientId: 'device',
            url: `http://127.0.0.1:${port}/push`,
            types: ['Email', 'EmailDelivery'],
          },
        },
      });
      const id = (created['created'] as { s: { id: string } }).s.id;
      expect(received[0]).toMatchObject({ '@type': 'PushVerification' });
      await set({
        update: {
          [id]: { verificationCode: received[0]?.['verificationCode'] },
        },
      });
      await jmap.provisionAccount(account);
      await jmap.importMessage(
        account,
        new TextEncoder().encode(buildMessage({ subject: 'Pushed' })),
        { mailboxRole: 'inbox', delivery: true },
      );

      const bundle = new URL('../dist/push.mjs', import.meta.url).href;
      const { handler } = (await import(
        /* @vite-ignore */ bundle
      )) as typeof import('./push.js');
      const stateItem = (accountId: string, type: string) => ({
        eventName: 'MODIFY',
        dynamodb: { Keys: { pk: { S: `S#${accountId}` }, sk: { S: type } } },
      });
      await handler({
        Records: [
          stateItem('acc-push', 'Email'),
          stateItem('acc-push', 'Thread'),
          stateItem('acc-push', 'EmailDelivery'),
          stateItem('acc-nobody', 'Email'),
        ],
      } as unknown as Parameters<typeof handler>[0]);

      expect(received).toHaveLength(2);
      const states = (
        received[1] as { changed: Record<string, Record<string, string>> }
      ).changed['acc-push'];
      expect(received[1]?.['@type']).toBe('StateChange');
      // Thread changed too, but this subscription did not ask about it.
      expect(Object.keys(states ?? {}).sort()).toEqual([
        'Email',
        'EmailDelivery',
      ]);
      expect(states?.['Email']).toMatch(/^s[1-9][0-9]*$/);
    } finally {
      pushService.close();
    }
  });
});

describe.skipIf(!reachable)('ingest Lambda entry point', () => {
  it('imports a message SES stored in the bucket', async () => {
    Object.assign(process.env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,
      AWS_ENDPOINT_URL_S3: s3Endpoint,
      S3_FORCE_PATH_STYLE: 'true',
      TABLE_NAME: tableName,
      BUCKET: bucket,
      MAILBOXES: JSON.stringify({ '*@example.com': 'acc-1' }),
    });
    // Load the bundle that is actually deployed, not the sources: bundling problems only show up there.
    const bundle = new URL('../dist/ingest.mjs', import.meta.url).href;
    const { handler } = (await import(
      /* @vite-ignore */ bundle
    )) as typeof import('./ingest.js');

    const raw = buildMessage({
      subject: 'Through the Lambda',
      text: 'Body text',
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: 'inbound/ses-msg-1',
        Body: raw,
      }),
    );
    const event = {
      Records: [
        {
          eventSource: 'aws:ses',
          eventVersion: '1.0',
          ses: {
            mail: {
              messageId: 'ses-msg-1',
              timestamp: '2026-10-07T09:30:00.000Z',
            },
            receipt: {
              recipients: ['me@example.com'],
              spamVerdict: { status: 'PASS' },
              virusVerdict: { status: 'PASS' },
            },
          },
        },
      ],
    } as unknown as SESEvent;

    await handler(event);
    await handler(event); // a retry after success must change nothing

    const keys = (
      await s3.send(new ListObjectsV2Command({ Bucket: bucket }))
    ).Contents?.map((object) => object.Key);
    expect(keys).toHaveLength(1);
    expect(keys?.[0]).toMatch(/^blobs\/acc-1\/bm[0-9a-f]{24}$/);

    // Read it back through an independently constructed server over the same storage.
    const jmap = createJmapServer({
      storage: {
        metadata: new DynamoDbMetadataStore({
          client: DynamoDBDocumentClient.from(dynamo),
          tableName,
        }),
        blobs: new S3BlobStore({ client: s3, bucket, keyPrefix: 'blobs/' }),
      },
      urls: { api: 'x', download: 'x', upload: 'x', eventSource: 'x' },
    });
    const response = await jmap.handleRequest(
      {
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Email/query', { accountId: 'acc-1' }, 'q'],
          [
            'Email/get',
            {
              accountId: 'acc-1',
              '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
              properties: ['subject', 'receivedAt', 'bodyValues', 'textBody'],
              fetchTextBodyValues: true,
            },
            'g',
          ],
          [
            'Mailbox/query',
            { accountId: 'acc-1', filter: { role: 'inbox' } },
            'mq',
          ],
          [
            'Mailbox/get',
            {
              accountId: 'acc-1',
              '#ids': { resultOf: 'mq', name: 'Mailbox/query', path: '/ids' },
              properties: ['totalEmails', 'unreadEmails'],
            },
            'mg',
          ],
        ],
      },
      { accountId: 'acc-1', username: 'me@example.com' },
    );
    const emails = (
      response.methodResponses[1]?.[1] as { list: Record<string, unknown>[] }
    ).list;
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      subject: 'Through the Lambda',
      receivedAt: '2026-10-07T09:30:00Z',
    });
    expect(JSON.stringify(emails[0]?.['bodyValues'])).toContain('Body text');
    expect(
      (response.methodResponses[3]?.[1] as { list: Record<string, unknown>[] })
        .list[0],
    ).toMatchObject({ totalEmails: 1, unreadEmails: 1 });
  });
});
