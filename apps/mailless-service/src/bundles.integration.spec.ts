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
import {
  directoryTableDefinition,
  DynamoDbDirectory,
} from '@mailless/directory-dynamodb';
import { issueTestToken, testKeys } from '@mailless/identity/testing';
import { createJmapServer } from '@mailless/jmap-server';
import { createAppPasswordStore } from '@mailless/app-passwords';
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
const directoryTable = `mailless-directory-${run}`;
// Stands in for the identity provider: tokens signed with these keys are its tokens.
const ISSUER = 'https://id.example.com/pool';
const providerKeys = testKeys();

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
  await dynamo.send(
    new CreateTableCommand(directoryTableDefinition(directoryTable)),
  );
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
} catch (error) {
  reachable = false;
  if (process.env['REQUIRE_LOCAL_SERVICES']) throw error;
  console.warn(
    'Skipping ingest integration test: local services are not reachable',
  );
}

afterAll(async () => {
  for (const TableName of [tableName, directoryTable]) {
    await dynamo
      .send(new DeleteTableCommand({ TableName }))
      .catch(() => undefined);
  }
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
      // Most accounts are in the table; one is still only in the environment.
      DIRECTORY_TABLE: directoryTable,
      MAILBOXES: JSON.stringify({ 'old@example.com': 'acc-old' }),
      // Tokens are checked as any OpenID Connect provider's, with claims named as Cognito names them.
      OIDC_ISSUER: ISSUER,
      OIDC_AUDIENCES: JSON.stringify(['mail-client']),
      OIDC_AUDIENCE_CLAIM: 'client_id',
      OIDC_USERNAME_CLAIM: 'username',
      OIDC_ROLES_CLAIM: 'cognito:groups',
      OIDC_REQUIRED_CLAIMS: JSON.stringify({ token_use: 'access' }),
      OIDC_JWKS: JSON.stringify(providerKeys.jwks),
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
    const directory = new DynamoDbDirectory({
      client: DynamoDBDocumentClient.from(dynamo),
      tableName: directoryTable,
    });
    await directory.createAccount({ id: 'acc-1' });
    await directory.addAddress('acc-1', 'me@example.com');
    await directory.createAccount({ id: 'acc-off' });
    await directory.updateAccount('acc-off', { status: 'disabled' });
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

    for (const username of ['acc-1', 'Me@Example.com']) {
      const accepted = await session(username, secret);
      expect(accepted.statusCode, username).toBe(200);
      expect(JSON.parse(accepted.body as string).username).toBe('acc-1');
    }

    const wrong = `${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`;
    expect((await session('acc-1', wrong)).statusCode).toBe(401);
    expect((await session('someone-else', secret)).statusCode).toBe(401);

    // A right password is not enough: the account must be one that is in use.
    const off = await passwords.create('acc-off', 'Switched off');
    expect((await session('acc-off', off.secret)).statusCode).toBe(401);
    const stray = await passwords.create('acc-stray', 'In no directory');
    expect((await session('acc-stray', stray.secret)).statusCode).toBe(401);
    // An account the table does not have yet is still found in the environment.
    const old = await passwords.create('acc-old', 'Not moved yet');
    expect((await session('old@example.com', old.secret)).statusCode).toBe(200);

    // A different spelling of the same secret is a fresh check, so revocation is seen at once.
    await passwords.revoke('acc-1', id);
    expect((await session('acc-1', secret.toUpperCase())).statusCode).toBe(401);
  });

  it('accepts the identity provider’s token for an account in use, and no other token', async () => {
    const bundle = new URL('../dist/api.mjs', import.meta.url).href;
    const { handler } = (await import(
      /* @vite-ignore */ bundle
    )) as typeof import('./api.js');
    const session = (claims: Record<string, unknown>, keys = providerKeys) =>
      handler({
        rawPath: '/.well-known/jmap',
        rawQueryString: '',
        headers: {
          authorization: `Bearer ${issueTestToken(keys, {
            iss: ISSUER,
            client_id: 'mail-client',
            token_use: 'access',
            username: 'acc-1',
            ...claims,
          })}`,
        },
        isBase64Encoded: false,
        requestContext: { domainName: 'internal', http: { method: 'GET' } },
      } as unknown as Parameters<typeof handler>[0]);

    const accepted = await session({});
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.body as string).username).toBe('acc-1');

    for (const [why, refused] of Object.entries({
      'issued for another client': session({ client_id: 'admin-client' }),
      'an id token': session({ token_use: 'id' }),
      'another issuer': session({ iss: 'https://elsewhere.example.com' }),
      expired: session({ exp: Math.floor(Date.now() / 1000) - 60 }),
      'signed by someone else': session({}, testKeys()),
      'an account that is switched off': session({ username: 'acc-off' }),
      'a user with no account': session({ username: 'acc-nobody' }),
    })) {
      expect((await refused).statusCode, why).toBe(401);
    }
  });
});

describe.skipIf(!reachable)('admin API Lambda bundle', () => {
  it('answers under /admin/api for a token issued to the admin interface, and no other', async () => {
    Object.assign(process.env, {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_ENDPOINT_URL_DYNAMODB: dynamoEndpoint,
      TABLE_NAME: tableName,
      DIRECTORY_TABLE: directoryTable,
      USER_POOL_ID: 'us-east-1_Example00',
      ADMIN_ROLE: 'MAILLESS_ADMIN',
      PASSKEY_ENROLMENT_URL: 'https://auth.example.com/passkeys/add',
      OIDC_ISSUER: ISSUER,
      OIDC_AUDIENCES: JSON.stringify(['admin-client']),
      OIDC_AUDIENCE_CLAIM: 'client_id',
      OIDC_USERNAME_CLAIM: 'username',
      OIDC_ROLES_CLAIM: 'cognito:groups',
      OIDC_REQUIRED_CLAIMS: JSON.stringify({ token_use: 'access' }),
      OIDC_JWKS: JSON.stringify(providerKeys.jwks),
      // What the pages are told, so that they can sign someone in.
      ADMIN_CLIENT_ID: 'admin-client',
      AUTH_AUTHORIZE_URL: 'https://auth.example.com/oauth2/authorize',
      AUTH_TOKEN_URL: 'https://auth.example.com/oauth2/token',
      AUTH_LOGOUT_URL: 'https://auth.example.com/logout',
      AUTH_SCOPES: JSON.stringify(['openid', 'aws.cognito.signin.user.admin']),
    });
    const bundle = new URL('../dist/admin-api.mjs', import.meta.url).href;
    const { handler } = (await import(
      /* @vite-ignore */ bundle
    )) as typeof import('./admin-api.js');
    const directory = new DynamoDbDirectory({
      client: DynamoDBDocumentClient.from(dynamo),
      tableName: directoryTable,
    });
    await directory.createAccount({ id: 'adm-1', name: 'Admin One' });
    await directory.addAddress('adm-1', 'admin@example.com');

    const call = async (
      method: string,
      path: string,
      claims: Record<string, unknown> | null,
      body?: unknown,
    ) => {
      const result = (await handler(
        {
          version: '2.0',
          routeKey: 'ANY /admin/api/{proxy+}',
          rawPath: path,
          rawQueryString: '',
          headers: {
            host: 'mail.example.com',
            ...(claims
              ? {
                  authorization: `Bearer ${issueTestToken(providerKeys, {
                    iss: ISSUER,
                    client_id: 'admin-client',
                    token_use: 'access',
                    username: 'adm-1',
                    ...claims,
                  })}`,
                }
              : {}),
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          isBase64Encoded: false,
          requestContext: {
            domainName: 'mail.example.com',
            http: { method, path },
          },
        } as unknown as Parameters<typeof handler>[0],
        {} as Parameters<typeof handler>[1],
      )) as { statusCode: number; body: string };
      return {
        status: result.statusCode,
        body: result.body ? JSON.parse(result.body) : null,
      };
    };

    expect((await call('GET', '/admin/api/me', null)).status).toBe(401);
    // A token issued to a mail client is not one for administering.
    expect(
      (await call('GET', '/admin/api/me', { client_id: 'mail-client' })).status,
    ).toBe(401);

    const me = await call('GET', '/admin/api/me', {});
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      username: 'adm-1',
      isAdmin: false,
      account: { id: 'adm-1', name: 'Admin One', status: 'active' },
      addresses: ['admin@example.com'],
      passkeyEnrolmentUrl: 'https://auth.example.com/passkeys/add',
    });

    // Without the role, accounts are out of reach; with it, the directory table is read.
    expect((await call('GET', '/admin/api/accounts', {})).status).toBe(403);
    const admin = { 'cognito:groups': ['MAILLESS_ADMIN'] };
    const accounts = await call('GET', '/admin/api/accounts', admin);
    expect(accounts.status).toBe(200);
    expect(
      accounts.body.map((account: { id: string }) => account.id),
    ).toContain('adm-1');
    await call(
      'PUT',
      '/admin/api/accounts/adm-1/addresses/second%40example.com',
      admin,
    );
    expect(await directory.resolveAddress('second@example.com')).toBe('adm-1');

    // An app password made here opens the mailbox through the JMAP API's own store.
    const made = await call(
      'POST',
      '/admin/api/me/app-passwords',
      {},
      {
        label: 'Laptop',
      },
    );
    expect(made.status).toBe(201);
    const passwords = createAppPasswordStore(
      new DynamoDbMetadataStore({
        client: DynamoDBDocumentClient.from(dynamo),
        tableName,
      }),
    );
    expect((await passwords.verify('adm-1', made.body.secret))?.label).toBe(
      'Laptop',
    );
    expect((await call('GET', '/elsewhere', admin)).status).toBe(404);

    // The pages themselves need no token: the built interface is in the bundle.
    const raw = async (path: string) =>
      (await handler(
        {
          version: '2.0',
          rawPath: path,
          rawQueryString: '',
          headers: { host: 'mail.example.com' },
          isBase64Encoded: false,
          requestContext: {
            domainName: 'mail.example.com',
            http: { method: 'GET', path },
          },
        } as unknown as Parameters<typeof handler>[0],
        {} as Parameters<typeof handler>[1],
      )) as {
        statusCode: number;
        body: string;
        headers: Record<string, string>;
      };
    for (const path of ['/admin', '/admin/', '/admin/accounts/adm-1']) {
      const page = await raw(path);
      expect(page.statusCode, path).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['content-security-policy']).toContain(
        "script-src 'self'",
      );
      expect(page.body).toContain('<div id="root">');
      // Every script and style the page asks for is one this function serves.
      for (const [, file] of page.body.matchAll(
        /(?:src|href)="\/admin\/([^"]+)"/g,
      )) {
        expect((await raw(`/admin/${file}`)).statusCode, file).toBe(200);
      }
    }
    const settings = await raw('/admin/config.json');
    expect(JSON.parse(settings.body)).toEqual({
      apiBaseUrl: '/admin/api',
      clientId: 'admin-client',
      authorizeUrl: 'https://auth.example.com/oauth2/authorize',
      tokenUrl: 'https://auth.example.com/oauth2/token',
      logoutUrl: 'https://auth.example.com/logout',
      scopes: ['openid', 'aws.cognito.signin.user.admin'],
      passkeyEnrolmentUrl: 'https://auth.example.com/passkeys/add',
    });
    expect((await raw('/admin/assets/nothing-here.js')).statusCode).toBe(404);
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
