import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_SUBMISSION,
  CAPABILITY_VACATION,
  REQUEST_ERROR,
  RequestError,
  type Invocation,
} from '@mailless/jmap-core';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createJmapServer, type JmapServer } from '../server.js';
import type { StorageAdapter } from '../storage.js';
import { MailRejectedError, type MailEnvelope } from '../transport.js';
import type { StorageAdapterFactory } from './storage-contract.js';

// Responses are untyped JSON; the tests assert on their shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const AUTH = { accountId: 'acc1', username: 'user@example.com' };
const USING = [
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_SUBMISSION,
  CAPABILITY_VACATION,
];
const URLS = {
  api: 'https://jmap.example.com/api',
  download:
    'https://jmap.example.com/download/{accountId}/{blobId}/{name}?type={type}',
  upload: 'https://jmap.example.com/upload/{accountId}',
  eventSource:
    'https://jmap.example.com/events?types={types}&closeafter={closeafter}&ping={ping}',
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The receiving side of a push subscription with keys (the example keys of RFC 8291).
const RECEIVER_PRIVATE = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94';
const RECEIVER_KEYS = {
  p256dh:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};

/** Decrypts a Web Push body (RFC 8291) as the client holding the keys would. */
function decryptPush(body: Uint8Array): Json {
  const salt = body.subarray(0, 16);
  const keyLength = body[20] as number;
  const senderPublic = body.subarray(21, 21 + keyLength);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(Buffer.from(RECEIVER_PRIVATE, 'base64url'));
  const derive = (
    key: Uint8Array,
    keySalt: Uint8Array,
    info: Uint8Array,
    length: number,
  ) => Buffer.from(hkdfSync('sha256', key, keySalt, info, length));
  const keyMaterial = derive(
    receiver.computeSecret(senderPublic),
    Buffer.from(RECEIVER_KEYS.auth, 'base64url'),
    Buffer.concat([
      encoder.encode('WebPush: info\0'),
      receiver.getPublicKey(),
      senderPublic,
    ]),
    32,
  );
  const decipher = createDecipheriv(
    'aes-128-gcm',
    derive(
      keyMaterial,
      salt,
      encoder.encode('Content-Encoding: aes128gcm\0'),
      16,
    ),
    derive(keyMaterial, salt, encoder.encode('Content-Encoding: nonce\0'), 12),
  );
  const ciphertext = body.subarray(21 + keyLength);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // The last byte is the 0x02 that ends the record.
  return JSON.parse(plaintext.subarray(0, plaintext.length - 1).toString());
}

export interface MessageOptions {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  text?: string;
  html?: string;
  /** With `html`: leave out the plain text alternative. */
  htmlOnly?: boolean;
  attachment?: { name: string; type: string; base64: string };
  headers?: string[];
}

/** Builds a small RFC 5322 message for tests. */
export function buildMessage(options: MessageOptions = {}): string {
  const lines = [
    `From: ${options.from ?? 'Alice <alice@example.com>'}`,
    `To: ${options.to ?? 'Bob <bob@example.com>'}`,
    ...(options.cc ? [`Cc: ${options.cc}`] : []),
    `Subject: ${options.subject ?? 'Hello'}`,
    `Message-ID: ${options.messageId ?? `<${Math.random().toString(36).slice(2)}@example.com>`}`,
    ...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []),
    ...(options.references ? [`References: ${options.references}`] : []),
    `Date: ${options.date ?? 'Tue, 06 Oct 2026 12:00:00 +0000'}`,
    ...(options.headers ?? []),
    'MIME-Version: 1.0',
  ];
  const text = options.text ?? 'Hello there, this is the body.';
  const textPart = ['Content-Type: text/plain; charset=utf-8', '', text];
  const htmlPart = options.html
    ? ['Content-Type: text/html; charset=utf-8', '', options.html]
    : null;

  let body: string[];
  if (htmlPart && options.htmlOnly) {
    body = htmlPart;
  } else if (htmlPart) {
    body = [
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      ...textPart,
      '--alt',
      ...htmlPart,
      '--alt--',
    ];
  } else {
    body = textPart;
  }

  if (options.attachment) {
    body = [
      'Content-Type: multipart/mixed; boundary="mix"',
      '',
      '--mix',
      ...body,
      '--mix',
      `Content-Type: ${options.attachment.type}; name="${options.attachment.name}"`,
      `Content-Disposition: attachment; filename="${options.attachment.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      options.attachment.base64,
      '--mix--',
    ];
  }
  return [...lines, ...body, ''].join('\r\n');
}

interface Harness {
  server: JmapServer;
  adapter: StorageAdapter;
  /** Everything handed to the transport, in order. */
  sent: Array<{ message: string; envelope: MailEnvelope }>;
  /** Makes the transport refuse the next message with this reason. */
  rejectNext(reason: string): void;
  /** Sends method calls, adding the account id, and returns the raw responses. */
  request(calls: Array<[string, Json]>): Promise<Invocation[]>;
  /** One call that must succeed; returns its response arguments. */
  call(name: string, args?: Json): Promise<Json>;
  /** One call that must fail at method level; returns the error object. */
  fail(name: string, args?: Json): Promise<Json>;
  mailbox(role: string): Promise<string>;
  upload(raw: string): Promise<string>;
  /** Uploads and imports a message; returns the created `{id, blobId, threadId, size}`. */
  deliver(
    mailboxId: string,
    options?: MessageOptions,
    extra?: Json,
  ): Promise<Json>;
}

async function createHarness(factory: StorageAdapterFactory): Promise<Harness> {
  const adapter = await factory();
  const sent: Harness['sent'] = [];
  let rejection: string | undefined;
  const server = createJmapServer({
    storage: adapter,
    urls: URLS,
    transport: {
      async send(message, envelope) {
        if (rejection !== undefined) {
          const reason = rejection;
          rejection = undefined;
          throw new MailRejectedError(reason);
        }
        sent.push({ message: decoder.decode(message), envelope });
        // Like services that replace the Message-ID header with one of their own.
        return { messageIds: [`relay-${sent.length}@relay.example`] };
      },
    },
    identities: () => [
      { id: 'me', email: 'me@example.com', name: 'Me Myself' },
      { id: 'team', email: '*@team.example.com' },
      {
        id: 'catchall',
        email: 'me@catch.example.com',
        allowedFrom: ['*@catch.example.com', 'legacy@old.example.com'],
      },
    ],
  });
  await server.provisionAccount(AUTH);

  const request: Harness['request'] = async (calls) => {
    const response = await server.handleRequest(
      {
        using: USING,
        methodCalls: calls.map(([name, args], index) => [
          name,
          { accountId: AUTH.accountId, ...args },
          `c${index}`,
        ]),
      },
      AUTH,
    );
    return response.methodResponses;
  };

  const call: Harness['call'] = async (name, args = {}) => {
    const [response] = await request([[name, args]]);
    expect(response?.[0], JSON.stringify(response?.[1])).toBe(name);
    return response?.[1];
  };

  const harness: Harness = {
    server,
    adapter,
    sent,
    rejectNext(reason) {
      rejection = reason;
    },
    request,
    call,
    async fail(name, args = {}) {
      const [response] = await request([[name, args]]);
      expect(response?.[0], JSON.stringify(response?.[1])).toBe('error');
      return response?.[1];
    },
    async mailbox(role) {
      const { ids } = await call('Mailbox/query', { filter: { role } });
      expect(ids).toHaveLength(1);
      return ids[0];
    },
    async upload(raw) {
      const { blobId } = await server.upload(
        AUTH,
        AUTH.accountId,
        encoder.encode(raw),
        'message/rfc822',
      );
      return blobId;
    },
    async deliver(mailboxId, options = {}, extra = {}) {
      const blobId = await harness.upload(buildMessage(options));
      const result = await call('Email/import', {
        emails: { m: { blobId, mailboxIds: { [mailboxId]: true }, ...extra } },
      });
      expect(result.notCreated).toBeNull();
      return result.created.m;
    },
  };
  return harness;
}

/**
 * Black-box JMAP behaviour tests (RFC 8620 and RFC 8621) run through
 * `handleRequest` against a storage adapter. Every adapter is expected to
 * pass the same suite.
 */
export function describeJmapConformance(
  name: string,
  factory: StorageAdapterFactory,
): void {
  describe(`${name}: JMAP core`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await createHarness(factory);
    });

    it('describes the session', () => {
      const session = h.server.getSession(AUTH);
      expect(Object.keys(session.capabilities).sort()).toEqual(
        [...USING].sort(),
      );
      expect(session.primaryAccounts[CAPABILITY_MAIL]).toBe(AUTH.accountId);
      expect(session.accounts[AUTH.accountId]?.name).toBe(AUTH.username);
      expect(session.apiUrl).toBe(URLS.api);
      expect(session.state).toBe(h.server.getSession(AUTH).state);
      expect(
        (session.capabilities[CAPABILITY_CORE] as Json).maxCallsInRequest,
      ).toBeGreaterThan(0);
    });

    it('echoes with Core/echo', async () => {
      const response = await h.server.handleRequest(
        {
          using: [CAPABILITY_CORE],
          methodCalls: [['Core/echo', { hello: true, n: [1, 2] }, 'x']],
        },
        AUTH,
      );
      expect(response.methodResponses).toEqual([
        ['Core/echo', { hello: true, n: [1, 2] }, 'x'],
      ]);
      expect(response.sessionState).toBe(h.server.getSession(AUTH).state);
      expect(response).not.toHaveProperty('createdIds');
    });

    it('rejects requests that are not a Request object', async () => {
      for (const bad of [
        null,
        [],
        { using: [] },
        { using: 'x', methodCalls: [] },
      ]) {
        await expect(h.server.handleRequest(bad, AUTH)).rejects.toMatchObject({
          type: REQUEST_ERROR.notRequest,
        });
      }
    });

    it('rejects unknown capabilities', async () => {
      const attempt = h.server.handleRequest(
        { using: [CAPABILITY_CORE, 'urn:example:nope'], methodCalls: [] },
        AUTH,
      );
      await expect(attempt).rejects.toBeInstanceOf(RequestError);
      await expect(attempt).rejects.toMatchObject({
        type: REQUEST_ERROR.unknownCapability,
      });
    });

    it('enforces maxCallsInRequest', async () => {
      const server = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        limits: { maxCallsInRequest: 2 },
      });
      const calls = [1, 2, 3].map((n) => ['Core/echo', {}, `c${n}`]);
      await expect(
        server.handleRequest(
          { using: [CAPABILITY_CORE], methodCalls: calls },
          AUTH,
        ),
      ).rejects.toMatchObject({
        type: REQUEST_ERROR.limit,
        limit: 'maxCallsInRequest',
      });
    });

    it('answers unknownMethod for unknown methods and unused capabilities', async () => {
      expect(await h.fail('Nope/get')).toEqual({ type: 'unknownMethod' });

      const response = await h.server.handleRequest(
        {
          using: [CAPABILITY_CORE],
          methodCalls: [['Mailbox/get', { accountId: AUTH.accountId }, 'a']],
        },
        AUTH,
      );
      expect(response.methodResponses[0]?.[1]).toEqual({
        type: 'unknownMethod',
      });
    });

    it('answers that there are no push subscriptions, and declines to create any', async () => {
      const response = await h.server.handleRequest(
        {
          using: [CAPABILITY_CORE],
          methodCalls: [
            ['PushSubscription/get', { ids: null }, 'a'],
            [
              'PushSubscription/get',
              { ids: ['p1'], properties: ['deviceClientId'] },
              'b',
            ],
            [
              'PushSubscription/set',
              {
                create: {
                  n: { deviceClientId: 'd', url: 'https://push.example/x' },
                },
                update: { p1: { expires: null } },
                destroy: ['p2'],
              },
              'c',
            ],
            ['PushSubscription/get', { accountId: AUTH.accountId }, 'd'],
          ],
        },
        AUTH,
      );
      expect(response.methodResponses).toEqual([
        ['PushSubscription/get', { list: [], notFound: [] }, 'a'],
        ['PushSubscription/get', { list: [], notFound: ['p1'] }, 'b'],
        [
          'PushSubscription/set',
          {
            created: null,
            updated: null,
            destroyed: null,
            notCreated: {
              n: {
                type: 'forbidden',
                description:
                  'Push notifications are not available on this server',
              },
            },
            notUpdated: { p1: { type: 'notFound' } },
            notDestroyed: { p2: { type: 'notFound' } },
          },
          'c',
        ],
        // Push subscriptions belong to the user, not an account, so accountId is not an argument.
        ['error', expect.objectContaining({ type: 'invalidArguments' }), 'd'],
      ]);
    });

    it('summarises each request by method name and outcome, without any data', async () => {
      const summaries: unknown[] = [];
      const server = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        onRequest: (summary) => summaries.push(summary),
      });
      await server.handleRequest(
        {
          using: [CAPABILITY_CORE, CAPABILITY_MAIL],
          methodCalls: [
            ['Core/echo', { secret: 'do-not-log-me' }, 'a'],
            ['Nope/get', {}, 'b'],
            [
              'Mailbox/set',
              {
                accountId: AUTH.accountId,
                create: {
                  ok: { name: 'Private folder name' },
                  bad: { name: '' },
                },
                destroy: ['missing'],
              },
              'c',
            ],
          ],
        },
        AUTH,
      );
      expect(summaries).toEqual([
        {
          calls: ['Core/echo', 'Nope/get', 'Mailbox/set'],
          results: [
            'Core/echo',
            'error:unknownMethod',
            'Mailbox/set!invalidProperties,notFound',
          ],
        },
      ]);
      expect(JSON.stringify(summaries)).not.toContain('do-not-log-me');
      expect(JSON.stringify(summaries)).not.toContain('Private folder name');
    });

    it('keeps processing after a failed call', async () => {
      const responses = await h.request([
        ['Nope/get', {}],
        ['Core/echo', { ok: 1 }],
      ]);
      expect(responses.map((response) => response[0])).toEqual([
        'error',
        'Core/echo',
      ]);
      expect(responses.map((response) => response[2])).toEqual(['c0', 'c1']);
    });

    it('rejects other accounts and unknown arguments', async () => {
      expect(
        (await h.fail('Mailbox/get', { accountId: 'someone-else' })).type,
      ).toBe('accountNotFound');
      expect((await h.fail('Mailbox/get', { bogus: true })).type).toBe(
        'invalidArguments',
      );
      expect((await h.fail('Mailbox/get', { ids: 'not-an-array' })).type).toBe(
        'invalidArguments',
      );
    });

    it('resolves result references between calls', async () => {
      const responses = await h.request([
        ['Mailbox/query', { filter: { role: 'inbox' } }],
        [
          'Mailbox/get',
          {
            '#ids': { resultOf: 'c0', name: 'Mailbox/query', path: '/ids' },
            properties: ['name'],
          },
        ],
      ]);
      expect(responses[1]?.[0]).toBe('Mailbox/get');
      expect((responses[1]?.[1] as Json).list).toEqual([
        { id: (responses[0]?.[1] as Json).ids[0], name: 'Inbox' },
      ]);
    });

    it('answers invalidResultReference for a bad reference', async () => {
      const responses = await h.request([
        ['Mailbox/query', {}],
        [
          'Mailbox/get',
          { '#ids': { resultOf: 'c0', name: 'Mailbox/query', path: '/nope' } },
        ],
        [
          'Mailbox/get',
          { '#ids': { resultOf: 'zz', name: 'Mailbox/query', path: '/ids' } },
        ],
      ]);
      expect(responses[1]?.[1]).toMatchObject({
        type: 'invalidResultReference',
      });
      expect(responses[2]?.[1]).toMatchObject({
        type: 'invalidResultReference',
      });
    });

    it('returns createdIds when the request supplies them', async () => {
      const response = await h.server.handleRequest(
        {
          using: USING,
          createdIds: {},
          methodCalls: [
            [
              'Mailbox/set',
              {
                accountId: AUTH.accountId,
                create: { k1: { name: 'Projects' } },
              },
              'a',
            ],
          ],
        },
        AUTH,
      );
      const created = (response.methodResponses[0]?.[1] as Json).created.k1;
      expect(response.createdIds).toEqual({ k1: created.id });
    });
  });

  describe(`${name}: Mailbox`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await createHarness(factory);
    });

    it('accepts server-set properties sent back unchanged, and names the ones that differ', async () => {
      const { created } = await h.call('Mailbox/set', {
        create: { m: { name: 'Projects' } },
      });
      const id = created.m.id;
      const [mailbox] = (await h.call('Mailbox/get', { ids: [id] })).list;

      // A client may send the whole object back with one thing changed.
      const renamed = await h.call('Mailbox/set', {
        update: { [id]: { ...mailbox, name: 'Projects 2026' } },
      });
      expect(renamed.updated).toEqual({ [id]: null });
      expect((await h.call('Mailbox/get', { ids: [id] })).list[0]).toEqual({
        ...mailbox,
        name: 'Projects 2026',
      });

      const refused = await h.call('Mailbox/set', {
        update: {
          [id]: {
            name: 'Not applied',
            id: `${id}x`,
            totalEmails: 52,
            unreadThreads: 52,
            myRights: {
              ...mailbox.myRights,
              mayDelete: false,
              mayRename: false,
            },
            'myRights/maySubmit': false,
            nonsense: true,
          },
        },
        create: {
          withId: { name: 'Has an id', id: 'chosen' },
          sameDefaults: {
            name: 'Same as the server would set',
            totalEmails: 0,
            myRights: mailbox.myRights,
          },
        },
      });
      expect(refused.notUpdated[id].type).toBe('invalidProperties');
      expect([...refused.notUpdated[id].properties].sort()).toEqual([
        'id',
        'myRights/mayDelete',
        'myRights/mayRename',
        'myRights/maySubmit',
        'nonsense',
        'totalEmails',
        'unreadThreads',
      ]);
      expect(refused.notCreated).toEqual({
        withId: expect.objectContaining({
          type: 'invalidProperties',
          properties: ['id'],
        }),
      });
      expect(Object.keys(refused.created)).toEqual(['sameDefaults']);
      expect((await h.call('Mailbox/get', { ids: [id] })).list[0].name).toBe(
        'Projects 2026',
      );
    });

    it('creates objects in the order their references need', async () => {
      // The child is listed first; it can only be created after its parent.
      const { created, notCreated } = await h.call('Mailbox/set', {
        create: {
          child: { name: 'Child', parentId: '#parent' },
          grandchild: { name: 'Grandchild', parentId: '#child' },
          parent: { name: 'Parent' },
          loopA: { name: 'A', parentId: '#loopB' },
          loopB: { name: 'B', parentId: '#loopA' },
        },
      });
      expect(Object.keys(created).sort()).toEqual([
        'child',
        'grandchild',
        'parent',
      ]);
      expect(Object.keys(notCreated).sort()).toEqual(['loopA', 'loopB']);
      const { list } = await h.call('Mailbox/get', {
        ids: [created.child.id, created.grandchild.id],
        properties: ['parentId'],
      });
      expect(list).toEqual([
        { id: created.child.id, parentId: created.parent.id },
        { id: created.grandchild.id, parentId: created.child.id },
      ]);
    });

    it('provisions the standard mailboxes once', async () => {
      await h.server.provisionAccount(AUTH);
      const { list, notFound, state } = await h.call('Mailbox/get', {
        ids: null,
      });
      expect(notFound).toEqual([]);
      expect(typeof state).toBe('string');
      expect(list.map((mailbox: Json) => mailbox.role).sort()).toEqual([
        'archive',
        'drafts',
        'inbox',
        'junk',
        'sent',
        'trash',
      ]);
      const inbox = list.find((mailbox: Json) => mailbox.role === 'inbox');
      expect(inbox).toMatchObject({
        name: 'Inbox',
        parentId: null,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        isSubscribed: true,
      });
      expect(inbox.myRights.mayAddItems).toBe(true);
    });

    it('returns requested properties and reports missing ids', async () => {
      const inbox = await h.mailbox('inbox');
      const result = await h.call('Mailbox/get', {
        ids: [inbox, 'missing'],
        properties: ['name', 'role'],
      });
      expect(result.list).toEqual([
        { id: inbox, name: 'Inbox', role: 'inbox' },
      ]);
      expect(result.notFound).toEqual(['missing']);
      expect((await h.fail('Mailbox/get', { properties: ['nope'] })).type).toBe(
        'invalidArguments',
      );
    });

    it('creates, updates and destroys', async () => {
      const before = await h.call('Mailbox/get', { ids: [] });
      const created = await h.call('Mailbox/set', {
        create: { a: { name: 'Projects' } },
      });
      expect(created.oldState).toBe(before.state);
      expect(created.newState).not.toBe(before.state);
      expect(created.notCreated).toBeNull();
      const id = created.created.a.id;
      expect(created.created.a).toMatchObject({
        parentId: null,
        role: null,
        sortOrder: 0,
        totalEmails: 0,
      });

      const updated = await h.call('Mailbox/set', {
        update: { [id]: { name: 'Work', sortOrder: 7 } },
      });
      expect(updated.updated).toEqual({ [id]: null });
      expect(updated.oldState).toBe(created.newState);
      const { list } = await h.call('Mailbox/get', { ids: [id] });
      expect(list[0]).toMatchObject({ name: 'Work', sortOrder: 7 });

      const destroyed = await h.call('Mailbox/set', {
        destroy: [id, 'missing'],
      });
      expect(destroyed.destroyed).toEqual([id]);
      expect(destroyed.notDestroyed).toEqual({ missing: { type: 'notFound' } });
      expect((await h.call('Mailbox/get', { ids: [id] })).notFound).toEqual([
        id,
      ]);
    });

    it('honours ifInState', async () => {
      const { state } = await h.call('Mailbox/get', { ids: [] });
      expect(
        await h.fail('Mailbox/set', {
          ifInState: 'stale',
          create: { a: { name: 'Nope' } },
        }),
      ).toEqual({ type: 'stateMismatch' });
      const ok = await h.call('Mailbox/set', {
        ifInState: state,
        create: { a: { name: 'Yes' }, b: { name: 'Also' } },
      });
      expect(Object.keys(ok.created)).toEqual(['a', 'b']);
    });

    it('validates what the client sets', async () => {
      const inbox = await h.mailbox('inbox');
      const result = await h.call('Mailbox/set', {
        create: {
          noName: {},
          emptyName: { name: '' },
          duplicate: { name: 'Inbox' },
          role: { name: 'Second inbox', role: 'inbox' },
          parent: { name: 'Orphan', parentId: 'missing' },
          serverSet: { name: 'Counts', totalEmails: 5 },
          unknown: { name: 'Extra', colour: 'red' },
          sortOrder: { name: 'Sort', sortOrder: -1 },
        },
        update: {
          [inbox]: { parentId: inbox },
          missing: { name: 'x' },
        },
      });
      expect(result.created).toBeNull();
      const properties = (key: string) => result.notCreated[key].properties;
      expect(result.notCreated.noName.type).toBe('invalidProperties');
      expect(properties('emptyName')).toEqual(['name']);
      expect(properties('duplicate')).toEqual(['name']);
      expect(properties('role')).toEqual(['role']);
      expect(properties('parent')).toEqual(['parentId']);
      expect(properties('serverSet')).toEqual(['totalEmails']);
      expect(properties('unknown')).toEqual(['colour']);
      expect(properties('sortOrder')).toEqual(['sortOrder']);
      expect(result.notUpdated[inbox].properties).toEqual(['parentId']);
      expect(result.notUpdated.missing).toEqual({ type: 'notFound' });
    });

    it('allows the same name under different parents and rejects cycles', async () => {
      const inbox = await h.mailbox('inbox');
      const first = await h.call('Mailbox/set', {
        create: {
          a: { name: 'Inbox', parentId: inbox },
          b: { name: 'Child', parentId: '#a' },
        },
      });
      expect(first.notCreated).toBeNull();
      const a = first.created.a.id;
      const b = first.created.b.id;
      expect((await h.call('Mailbox/get', { ids: [b] })).list[0].parentId).toBe(
        a,
      );

      const cycle = await h.call('Mailbox/set', {
        update: { [a]: { parentId: b } },
      });
      expect(cycle.notUpdated[a].properties).toEqual(['parentId']);
    });

    it('rejects invalid patches', async () => {
      const inbox = await h.mailbox('inbox');
      const result = await h.call('Mailbox/set', {
        update: { [inbox]: { 'name/first': 'x' } },
      });
      expect(result.notUpdated[inbox].type).toBe('invalidPatch');
    });

    it('resolves creation ids across calls in one request', async () => {
      const responses = await h.request([
        ['Mailbox/set', { create: { top: { name: 'Top' } } }],
        ['Mailbox/set', { create: { sub: { name: 'Sub', parentId: '#top' } } }],
      ]);
      const top = (responses[0]?.[1] as Json).created.top.id;
      const sub = (responses[1]?.[1] as Json).created.sub.id;
      expect(
        (await h.call('Mailbox/get', { ids: [sub] })).list[0].parentId,
      ).toBe(top);
    });

    it('refuses to destroy a mailbox with children', async () => {
      const inbox = await h.mailbox('inbox');
      await h.call('Mailbox/set', {
        create: { a: { name: 'Sub', parentId: inbox } },
      });
      const result = await h.call('Mailbox/set', { destroy: [inbox] });
      expect(result.notDestroyed[inbox].type).toBe('mailboxHasChild');
    });

    it('queries with filters, sorting and paging', async () => {
      const inbox = await h.mailbox('inbox');
      await h.call('Mailbox/set', {
        create: {
          a: {
            name: 'Zeta',
            parentId: inbox,
            sortOrder: 1,
            isSubscribed: false,
          },
          b: { name: 'Alpha', parentId: inbox, sortOrder: 2 },
        },
      });
      const names = async (args: Json) => {
        const { ids } = await h.call('Mailbox/query', args);
        const { list } = await h.call('Mailbox/get', {
          ids,
          properties: ['name'],
        });
        const byId = new Map(
          list.map((mailbox: Json) => [mailbox.id, mailbox.name]),
        );
        return ids.map((id: string) => byId.get(id));
      };

      expect(
        await names({
          filter: { parentId: inbox },
          sort: [{ property: 'name' }],
        }),
      ).toEqual(['Alpha', 'Zeta']);
      expect(
        await names({
          filter: { parentId: inbox },
          sort: [{ property: 'name', isAscending: false }],
        }),
      ).toEqual(['Zeta', 'Alpha']);
      expect(
        await names({
          filter: { hasAnyRole: false },
          sort: [{ property: 'sortOrder' }],
        }),
      ).toEqual(['Zeta', 'Alpha']);
      expect(await names({ filter: { name: 'ALP' } })).toEqual(['Alpha']);
      expect(await names({ filter: { isSubscribed: false } })).toEqual([
        'Zeta',
      ]);
      expect(
        await names({
          filter: {
            operator: 'OR',
            conditions: [{ role: 'trash' }, { name: 'zeta' }],
          },
          sort: [{ property: 'name' }],
        }),
      ).toEqual(['Trash', 'Zeta']);
      expect(
        await names({
          filter: { operator: 'NOT', conditions: [{ hasAnyRole: true }] },
          sort: [{ property: 'name' }],
        }),
      ).toEqual(['Alpha', 'Zeta']);

      const tree = await names({
        sort: [{ property: 'sortOrder' }, { property: 'name' }],
        sortAsTree: true,
      });
      expect(tree.slice(0, 4)).toEqual(['Inbox', 'Zeta', 'Alpha', 'Drafts']);

      const page = await h.call('Mailbox/query', {
        sort: [{ property: 'sortOrder' }, { property: 'name' }],
        position: 1,
        limit: 2,
        calculateTotal: true,
      });
      expect(page.ids).toHaveLength(2);
      expect(page.position).toBe(1);
      expect(page.total).toBe(8);
      expect(page.canCalculateChanges).toBe(true);

      expect(
        (await h.fail('Mailbox/query', { filter: { nope: 1 } })).type,
      ).toBe('invalidArguments');
      expect(
        (await h.fail('Mailbox/query', { sort: [{ property: 'nope' }] })).type,
      ).toBe('unsupportedSort');
      expect(
        (await h.fail('Mailbox/queryChanges', { sinceQueryState: 'x' })).type,
      ).toBe('cannotCalculateChanges');
    });

    it('applies filterAsTree', async () => {
      const inbox = await h.mailbox('inbox');
      const created = await h.call('Mailbox/set', {
        create: {
          a: { name: 'Keep', parentId: inbox, isSubscribed: false },
          b: { name: 'Nested', parentId: '#a', isSubscribed: false },
        },
      });
      const flat = await h.call('Mailbox/query', {
        filter: { isSubscribed: false },
      });
      expect(flat.ids.sort()).toEqual(
        [created.created.a.id, created.created.b.id].sort(),
      );
      const asTree = await h.call('Mailbox/query', {
        filter: { isSubscribed: false },
        filterAsTree: true,
      });
      expect(asTree.ids).toEqual([]);
    });

    it('reports changes since a state', async () => {
      const { state: s0 } = await h.call('Mailbox/get', { ids: [] });
      const inbox = await h.mailbox('inbox');
      const created = await h.call('Mailbox/set', {
        create: { a: { name: 'A' }, b: { name: 'B' } },
      });
      const a = created.created.a.id;
      const b = created.created.b.id;
      await h.call('Mailbox/set', {
        update: { [inbox]: { sortOrder: 9 }, [a]: { name: 'A2' } },
      });
      await h.call('Mailbox/set', { destroy: [b] });

      const changes = await h.call('Mailbox/changes', { sinceState: s0 });
      expect(changes.oldState).toBe(s0);
      expect(changes.newState).toBe(
        (await h.call('Mailbox/get', { ids: [] })).state,
      );
      expect(changes.hasMoreChanges).toBe(false);
      expect(changes.created).toEqual([a]);
      expect(changes.updated).toEqual([inbox]);
      expect(changes.destroyed).toEqual([]);
      expect(changes.updatedProperties).toBeNull();

      const none = await h.call('Mailbox/changes', {
        sinceState: changes.newState,
      });
      expect(none).toMatchObject({
        created: [],
        updated: [],
        destroyed: [],
        hasMoreChanges: false,
        newState: changes.newState,
      });

      await h.call('Mailbox/set', { destroy: [a] });
      const after = await h.call('Mailbox/changes', {
        sinceState: changes.newState,
      });
      expect(after.destroyed).toEqual([a]);

      expect(
        (await h.fail('Mailbox/changes', { sinceState: 'bogus' })).type,
      ).toBe('cannotCalculateChanges');
    });

    it('pages changes with maxChanges', async () => {
      const { state: s0 } = await h.call('Mailbox/get', { ids: [] });
      const ids: string[] = [];
      for (const name of ['One', 'Two', 'Three']) {
        const result = await h.call('Mailbox/set', { create: { m: { name } } });
        ids.push(result.created.m.id);
      }

      const seen: string[] = [];
      let state = s0;
      for (let round = 0; round < 5; round++) {
        const changes = await h.call('Mailbox/changes', {
          sinceState: state,
          maxChanges: 2,
        });
        expect(changes.created.length).toBeLessThanOrEqual(2);
        seen.push(...changes.created);
        state = changes.newState;
        if (!changes.hasMoreChanges) break;
        expect(changes.created.length).toBeGreaterThan(0);
      }
      expect(seen).toEqual(ids);
      expect(state).toBe((await h.call('Mailbox/get', { ids: [] })).state);
    });
  });

  describe(`${name}: Email`, () => {
    let h: Harness;
    let inbox: string;
    let archive: string;
    beforeEach(async () => {
      h = await createHarness(factory);
      inbox = await h.mailbox('inbox');
      archive = await h.mailbox('archive');
    });

    const counts = async (mailboxId: string) => {
      const { list } = await h.call('Mailbox/get', {
        ids: [mailboxId],
        properties: [
          'totalEmails',
          'unreadEmails',
          'totalThreads',
          'unreadThreads',
        ],
      });
      const { totalEmails, unreadEmails, totalThreads, unreadThreads } =
        list[0];
      return { totalEmails, unreadEmails, totalThreads, unreadThreads };
    };

    it('imports a message and returns its metadata', async () => {
      const raw = buildMessage({
        from: '=?utf-8?Q?J=C3=B6rg?= <jorg@example.com>',
        to: 'Bob <bob@example.com>, carol@example.com',
        subject: 'Quarterly numbers',
        messageId: '<q1@example.com>',
        date: 'Tue, 06 Oct 2026 14:00:00 +0200',
        text: 'Line one.\r\nLine two with   spaces.',
      });
      const blobId = await h.upload(raw);
      const result = await h.call('Email/import', {
        emails: {
          m: {
            blobId,
            mailboxIds: { [inbox]: true },
            keywords: { $seen: true },
            receivedAt: '2026-10-06T12:00:05Z',
          },
        },
      });
      const created = result.created.m;
      expect(created.size).toBe(encoder.encode(raw).length);
      expect(result.oldState).not.toBe(result.newState);

      const { list, state } = await h.call('Email/get', { ids: [created.id] });
      expect(state).toBe(result.newState);
      expect(list[0]).toMatchObject({
        id: created.id,
        blobId: created.blobId,
        threadId: created.threadId,
        mailboxIds: { [inbox]: true },
        keywords: { $seen: true },
        size: created.size,
        receivedAt: '2026-10-06T12:00:05Z',
        messageId: ['q1@example.com'],
        inReplyTo: null,
        references: null,
        sender: null,
        from: [{ name: 'Jörg', email: 'jorg@example.com' }],
        to: [
          { name: 'Bob', email: 'bob@example.com' },
          { name: null, email: 'carol@example.com' },
        ],
        cc: null,
        subject: 'Quarterly numbers',
        sentAt: '2026-10-06T14:00:00+02:00',
        hasAttachment: false,
        preview: 'Line one. Line two with spaces.',
        bodyValues: {},
        attachments: [],
      });
      expect(list[0].textBody).toEqual(list[0].htmlBody);
      expect(list[0].textBody[0]).toMatchObject({
        partId: '1',
        type: 'text/plain',
        charset: 'utf-8',
      });
      expect(list[0]).not.toHaveProperty('headers');
      expect(list[0]).not.toHaveProperty('bodyStructure');

      const stored = await h.server.download(
        AUTH,
        AUTH.accountId,
        created.blobId,
      );
      expect(decoder.decode(stored ?? new Uint8Array())).toBe(raw);
    });

    it('returns body values, structure and attachments', async () => {
      const created = await h.deliver(inbox, {
        text: 'Plain body',
        html: '<p>Rich <b>body</b></p>',
        attachment: {
          name: 'note.txt',
          type: 'text/plain',
          base64: 'YXR0YWNoZWQ=',
        },
      });
      const { list } = await h.call('Email/get', {
        ids: [created.id],
        properties: [
          'bodyStructure',
          'bodyValues',
          'textBody',
          'htmlBody',
          'attachments',
          'hasAttachment',
        ],
        bodyProperties: [
          'partId',
          'blobId',
          'type',
          'name',
          'size',
          'disposition',
          'subParts',
        ],
        fetchAllBodyValues: true,
      });
      const email = list[0];
      expect(email.hasAttachment).toBe(true);
      expect(email.bodyStructure.type).toBe('multipart/mixed');
      expect(email.bodyStructure.subParts[0].type).toBe(
        'multipart/alternative',
      );
      expect(email.textBody.map((part: Json) => part.type)).toEqual([
        'text/plain',
      ]);
      expect(email.htmlBody.map((part: Json) => part.type)).toEqual([
        'text/html',
      ]);
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0]).toMatchObject({
        name: 'note.txt',
        type: 'text/plain',
        disposition: 'attachment',
        size: 8,
      });

      const textId = email.textBody[0].partId;
      const htmlId = email.htmlBody[0].partId;
      expect(email.bodyValues[textId]).toEqual({
        value: 'Plain body',
        isEncodingProblem: false,
        isTruncated: false,
      });
      expect(email.bodyValues[htmlId].value).toContain('<b>body</b>');
      expect(email.bodyValues[email.attachments[0].partId].value).toBe(
        'attached',
      );

      const attachment = await h.server.download(
        AUTH,
        AUTH.accountId,
        email.attachments[0].blobId,
      );
      expect(decoder.decode(attachment ?? new Uint8Array())).toBe('attached');

      const onlyText = await h.call('Email/get', {
        ids: [created.id],
        properties: ['bodyValues'],
        fetchTextBodyValues: true,
        maxBodyValueBytes: 5,
      });
      expect(onlyText.list[0].bodyValues).toEqual({
        [textId]: {
          value: 'Plain',
          isEncodingProblem: false,
          isTruncated: true,
        },
      });
    });

    it('does not split a character when truncating body values', async () => {
      const created = await h.deliver(inbox, { text: 'aé€' });
      const get = async (maxBodyValueBytes: number) =>
        (
          await h.call('Email/get', {
            ids: [created.id],
            properties: ['bodyValues'],
            fetchTextBodyValues: true,
            maxBodyValueBytes,
          })
        ).list[0].bodyValues['1'];
      expect(await get(2)).toMatchObject({ value: 'a', isTruncated: true });
      expect(await get(3)).toMatchObject({ value: 'aé', isTruncated: true });
      const whole = await get(100);
      expect(whole.isTruncated).toBe(false);
      expect(whole.value.trim()).toBe('aé€');
    });

    it('exposes headers in the requested forms', async () => {
      const created = await h.deliver(inbox, {
        from: '=?utf-8?Q?J=C3=B6rg?= <jorg@example.com>',
        to: 'Team <team@example.com>, Friends: a@example.org, b@example.org;',
        subject: 'A subject that\r\n is folded',
        messageId: '<h1@example.com>',
        date: 'Tue, 06 Oct 2026 14:00:00 +0200',
        headers: [
          'X-Tag: one',
          'X-Tag: two',
          'List-Unsubscribe: <https://example.com/u>, <mailto:u@example.com>',
        ],
      });
      const { list } = await h.call('Email/get', {
        ids: [created.id],
        properties: [
          'headers',
          'header:Subject',
          'header:subject:asText',
          'header:From:asAddresses',
          'header:To:asGroupedAddresses',
          'header:Message-ID:asMessageIds',
          'header:Date:asDate',
          'header:List-Unsubscribe:asURLs',
          'header:X-Tag:asText',
          'header:X-Tag:asText:all',
          'header:X-Missing',
          'header:X-Missing:all',
        ],
      });
      const email = list[0];
      expect(
        email.headers.slice(0, 2).map((header: Json) => header.name),
      ).toEqual(['From', 'To']);
      expect(email['header:Subject']).toBe(' A subject that\r\n is folded');
      expect(email['header:subject:asText']).toBe('A subject that is folded');
      expect(email['header:From:asAddresses']).toEqual([
        { name: 'Jörg', email: 'jorg@example.com' },
      ]);
      expect(email['header:To:asGroupedAddresses']).toEqual([
        {
          name: null,
          addresses: [{ name: 'Team', email: 'team@example.com' }],
        },
        {
          name: 'Friends',
          addresses: [
            { name: null, email: 'a@example.org' },
            { name: null, email: 'b@example.org' },
          ],
        },
      ]);
      expect(email['header:Message-ID:asMessageIds']).toEqual([
        'h1@example.com',
      ]);
      // The time as the sender wrote it, with their offset.
      expect(email['header:Date:asDate']).toBe('2026-10-06T14:00:00+02:00');
      expect(email['header:List-Unsubscribe:asURLs']).toEqual([
        'https://example.com/u',
        'mailto:u@example.com',
      ]);
      expect(email['header:X-Tag:asText']).toBe('two');
      expect(email['header:X-Tag:asText:all']).toEqual(['one', 'two']);
      expect(email['header:X-Missing']).toBeNull();
      expect(email['header:X-Missing:all']).toEqual([]);

      expect(
        (
          await h.fail('Email/get', {
            ids: [created.id],
            properties: ['header:X:asNope'],
          })
        ).type,
      ).toBe('invalidArguments');
      expect(
        (await h.fail('Email/get', { ids: [created.id], properties: ['nope'] }))
          .type,
      ).toBe('invalidArguments');
    });

    it('keeps every address of a From header with several', async () => {
      const created = await h.deliver(inbox, {
        from: 'Alice <alice@example.com>, =?utf-8?Q?J=C3=B6rg?= <jorg@example.org>',
      });
      const { list } = await h.call('Email/get', {
        ids: [created.id],
        properties: ['from', 'sender'],
      });
      expect(list[0].from).toEqual([
        { name: 'Alice', email: 'alice@example.com' },
        { name: 'Jörg', email: 'jorg@example.org' },
      ]);
      expect(list[0].sender).toBeNull();
      expect(
        (await h.call('Email/query', { filter: { from: 'jorg@example.org' } }))
          .ids,
      ).toEqual([created.id]);
    });

    it('rejects bad imports one by one', async () => {
      const blobId = await h.upload(buildMessage());
      const result = await h.call('Email/import', {
        emails: {
          noBlob: { blobId: 'missing', mailboxIds: { [inbox]: true } },
          noMailbox: { blobId, mailboxIds: {} },
          badMailbox: { blobId, mailboxIds: { missing: true } },
          badKeyword: {
            blobId,
            mailboxIds: { [inbox]: true },
            keywords: { 'has space': true },
          },
          badDate: {
            blobId,
            mailboxIds: { [inbox]: true },
            receivedAt: 'yesterday',
          },
          extra: { blobId, mailboxIds: { [inbox]: true }, nope: 1 },
          good: { blobId, mailboxIds: { [inbox]: true } },
        },
      });
      expect(Object.keys(result.created)).toEqual(['good']);
      // RFC 8621 §4.8: for an import, a blob that is not found is an invalid property.
      expect(result.notCreated.noBlob).toMatchObject({
        type: 'invalidProperties',
        properties: ['blobId'],
      });
      expect(result.notCreated.noMailbox.properties).toEqual(['mailboxIds']);
      expect(result.notCreated.badMailbox.properties).toEqual(['mailboxIds']);
      expect(result.notCreated.badKeyword.properties).toEqual(['keywords']);
      expect(result.notCreated.badDate.properties).toEqual(['receivedAt']);
      expect(result.notCreated.extra.type).toBe('invalidProperties');
      expect((await counts(inbox)).totalEmails).toBe(1);
    });

    it('rejects content that is not a message', async () => {
      const blobId = await h.upload('this is not an email');
      const result = await h.call('Email/import', {
        emails: { m: { blobId, mailboxIds: { [inbox]: true } } },
      });
      expect(result.notCreated.m.type).toBe('invalidEmail');
    });

    it('imports into a mailbox created earlier in the same request', async () => {
      const blobId = await h.upload(
        buildMessage({ subject: 'Into new mailbox' }),
      );
      const responses = await h.request([
        ['Mailbox/set', { create: { box: { name: 'Receipts' } } }],
        [
          'Email/import',
          { emails: { m: { blobId, mailboxIds: { '#box': true } } } },
        ],
        ['Email/query', { filter: { subject: 'new mailbox' } }],
        [
          'Email/get',
          {
            '#ids': { resultOf: 'c2', name: 'Email/query', path: '/ids' },
            properties: ['mailboxIds', 'subject'],
          },
        ],
      ]);
      expect(responses.map((response) => response[0])).toEqual([
        'Mailbox/set',
        'Email/import',
        'Email/query',
        'Email/get',
      ]);
      const boxId = (responses[0]?.[1] as Json).created.box.id;
      expect((responses[3]?.[1] as Json).list).toEqual([
        {
          id: (responses[1]?.[1] as Json).created.m.id,
          mailboxIds: { [boxId]: true },
          subject: 'Into new mailbox',
        },
      ]);
    });

    it('threads replies and keeps unrelated mail apart', async () => {
      const first = await h.deliver(
        inbox,
        { subject: 'Lunch?', messageId: '<t1@example.com>' },
        { receivedAt: '2026-10-01T10:00:00Z' },
      );
      const reply = await h.deliver(
        inbox,
        {
          subject: 'Re: Lunch?',
          messageId: '<t2@example.com>',
          inReplyTo: '<t1@example.com>',
          references: '<t1@example.com>',
        },
        { receivedAt: '2026-10-01T11:00:00Z' },
      );
      const later = await h.deliver(
        archive,
        {
          subject: 'RE: Fwd: lunch?',
          messageId: '<t3@example.com>',
          references: '<t1@example.com> <t2@example.com>',
        },
        { receivedAt: '2026-10-01T12:00:00Z' },
      );
      const sameReferenceOtherSubject = await h.deliver(inbox, {
        subject: 'Something else entirely',
        references: '<t1@example.com>',
      });
      const unrelated = await h.deliver(inbox, { subject: 'Lunch?' });

      expect(reply.threadId).toBe(first.threadId);
      expect(later.threadId).toBe(first.threadId);
      expect(sameReferenceOtherSubject.threadId).not.toBe(first.threadId);
      expect(unrelated.threadId).not.toBe(first.threadId);

      const { list, notFound } = await h.call('Thread/get', {
        ids: [first.threadId, 'missing'],
      });
      expect(list).toEqual([
        { id: first.threadId, emailIds: [first.id, reply.id, later.id] },
      ]);
      expect(notFound).toEqual(['missing']);
    });

    it('joins a thread when the parent arrives after the reply', async () => {
      const reply = await h.deliver(inbox, {
        subject: 'Re: Out of order',
        messageId: '<o2@example.com>',
        inReplyTo: '<o1@example.com>',
      });
      const parent = await h.deliver(inbox, {
        subject: 'Out of order',
        messageId: '<o1@example.com>',
      });
      expect(parent.threadId).toBe(reply.threadId);
    });

    it('keeps mailbox counts in step with every change', async () => {
      const zero = {
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
      };
      expect(await counts(inbox)).toEqual(zero);

      const a = await h.deliver(inbox, {
        subject: 'A',
        messageId: '<a@example.com>',
      });
      const b = await h.deliver(inbox, { subject: 'B' });
      expect(await counts(inbox)).toEqual({
        totalEmails: 2,
        unreadEmails: 2,
        totalThreads: 2,
        unreadThreads: 2,
      });

      await h.call('Email/set', {
        update: { [a.id]: { 'keywords/$seen': true } },
      });
      expect(await counts(inbox)).toEqual({
        totalEmails: 2,
        unreadEmails: 1,
        totalThreads: 2,
        unreadThreads: 1,
      });

      const reply = await h.deliver(inbox, {
        subject: 'Re: A',
        inReplyTo: '<a@example.com>',
      });
      expect(reply.threadId).toBe(a.threadId);
      expect(await counts(inbox)).toEqual({
        totalEmails: 3,
        unreadEmails: 2,
        totalThreads: 2,
        unreadThreads: 2,
      });

      await h.call('Email/set', {
        update: { [reply.id]: { mailboxIds: { [archive]: true } } },
      });
      expect(await counts(inbox)).toEqual({
        totalEmails: 2,
        unreadEmails: 1,
        totalThreads: 2,
        unreadThreads: 2,
      });
      expect(await counts(archive)).toEqual({
        totalEmails: 1,
        unreadEmails: 1,
        totalThreads: 1,
        unreadThreads: 1,
      });

      await h.call('Email/set', {
        update: { [b.id]: { [`mailboxIds/${archive}`]: true } },
      });
      expect((await counts(archive)).totalEmails).toBe(2);
      expect((await counts(inbox)).totalEmails).toBe(2);

      await h.call('Email/set', { destroy: [a.id, b.id, reply.id] });
      expect(await counts(inbox)).toEqual(zero);
      expect(await counts(archive)).toEqual(zero);
    });

    it('treats drafts as read for the unread counts', async () => {
      await h.deliver(inbox, {}, { keywords: { $draft: true } });
      expect(await counts(inbox)).toMatchObject({
        totalEmails: 1,
        unreadEmails: 0,
      });
    });

    it('updates keywords and mailboxes with Email/set', async () => {
      const email = await h.deliver(inbox);
      const before = await h.call('Email/get', {
        ids: [email.id],
        properties: ['id'],
      });

      const result = await h.call('Email/set', {
        update: {
          [email.id]: {
            'keywords/$Flagged': true,
            [`mailboxIds/${archive}`]: true,
          },
        },
      });
      expect(result.updated).toEqual({ [email.id]: null });
      expect(result.oldState).toBe(before.state);
      expect(result.newState).not.toBe(before.state);

      const read = async () =>
        (
          await h.call('Email/get', {
            ids: [email.id],
            properties: ['keywords', 'mailboxIds'],
          })
        ).list[0];
      expect(await read()).toEqual({
        id: email.id,
        keywords: { $flagged: true },
        mailboxIds: { [inbox]: true, [archive]: true },
      });

      await h.call('Email/set', {
        update: {
          [email.id]: {
            keywords: { $seen: true },
            [`mailboxIds/${inbox}`]: null,
          },
        },
      });
      expect(await read()).toEqual({
        id: email.id,
        keywords: { $seen: true },
        mailboxIds: { [archive]: true },
      });

      const stateBefore = (await h.call('Email/get', { ids: [] })).state;
      const noop = await h.call('Email/set', {
        update: { [email.id]: { 'keywords/$seen': true } },
      });
      expect(noop.updated).toEqual({ [email.id]: null });
      expect(noop.newState).toBe(stateBefore);
    });

    it('rejects invalid Email/set changes', async () => {
      const email = await h.deliver(inbox);
      const other = await h.deliver(inbox);
      const result = await h.call('Email/set', {
        create: { n: { subject: 'new' } },
        update: {
          [email.id]: { subject: 'changed' },
          [other.id]: { mailboxIds: {} },
          missing: { 'keywords/$seen': true },
        },
      });
      expect(result.notCreated.n.type).toBe('invalidProperties');
      expect(result.notUpdated[email.id]).toMatchObject({
        type: 'invalidProperties',
        properties: ['subject'],
      });
      expect(result.notUpdated[other.id].properties).toEqual(['mailboxIds']);
      expect(result.notUpdated.missing).toEqual({ type: 'notFound' });

      const more = await h.call('Email/set', {
        update: {
          [email.id]: { 'keywords/bad keyword': true },
          [other.id]: { 'mailboxIds/missing': true },
        },
      });
      expect(more.notUpdated[email.id].properties).toEqual(['keywords']);
      expect(more.notUpdated[other.id].properties).toEqual(['mailboxIds']);

      const willDestroy = await h.call('Email/set', {
        update: { [email.id]: { 'keywords/$seen': true } },
        destroy: [email.id],
      });
      expect(willDestroy.notUpdated[email.id].type).toBe('willDestroy');
      expect(willDestroy.destroyed).toEqual([email.id]);
    });

    it('destroys emails together with their content and empty threads', async () => {
      const first = await h.deliver(inbox, {
        subject: 'T',
        messageId: '<d1@example.com>',
      });
      const second = await h.deliver(inbox, {
        subject: 'Re: T',
        inReplyTo: '<d1@example.com>',
      });

      const one = await h.call('Email/set', { destroy: [first.id, 'missing'] });
      expect(one.destroyed).toEqual([first.id]);
      expect(one.notDestroyed).toEqual({ missing: { type: 'notFound' } });
      expect((await h.call('Email/get', { ids: [first.id] })).notFound).toEqual(
        [first.id],
      );
      expect(
        await h.server.download(AUTH, AUTH.accountId, first.blobId),
      ).toBeNull();
      expect(
        (await h.call('Thread/get', { ids: [first.threadId] })).list,
      ).toEqual([{ id: first.threadId, emailIds: [second.id] }]);

      await h.call('Email/set', { destroy: [second.id] });
      expect(
        (await h.call('Thread/get', { ids: [first.threadId] })).notFound,
      ).toEqual([first.threadId]);
    });

    it('handles mailboxes that still contain email on destroy', async () => {
      const created = await h.call('Mailbox/set', {
        create: { box: { name: 'Temp' } },
      });
      const box = created.created.box.id;
      const onlyHere = await h.deliver(box);
      const alsoInbox = await h.deliver(box);
      await h.call('Email/set', {
        update: { [alsoInbox.id]: { [`mailboxIds/${inbox}`]: true } },
      });

      const refused = await h.call('Mailbox/set', { destroy: [box] });
      expect(refused.notDestroyed[box].type).toBe('mailboxHasEmail');

      const removed = await h.call('Mailbox/set', {
        destroy: [box],
        onDestroyRemoveEmails: true,
      });
      expect(removed.destroyed).toEqual([box]);
      const { list, notFound } = await h.call('Email/get', {
        ids: [onlyHere.id, alsoInbox.id],
        properties: ['mailboxIds'],
      });
      expect(notFound).toEqual([onlyHere.id]);
      expect(list).toEqual([
        { id: alsoInbox.id, mailboxIds: { [inbox]: true } },
      ]);
      expect(
        await h.server.download(AUTH, AUTH.accountId, onlyHere.blobId),
      ).toBeNull();
      expect((await counts(inbox)).totalEmails).toBe(1);
    });

    it('reads the real structure of an email stored under the older layout', async () => {
      const inbox = await h.mailbox('inbox');
      const { id } = await h.deliver(inbox, {
        html: '<p>Rich</p>',
        text: 'Plain',
        attachment: {
          name: 'a.bin',
          type: 'application/x-thing',
          base64: 'AAEC',
        },
      });
      const properties = [
        'bodyStructure',
        'textBody',
        'htmlBody',
        'attachments',
      ];
      const read = async () =>
        (await h.call('Email/get', { ids: [id], properties })).list[0];
      const current = await read();
      expect(current.bodyStructure.type).toBe('multipart/mixed');
      expect(current.bodyStructure.subParts[0].type).toBe(
        'multipart/alternative',
      );

      // As an older version left it: no layout version, and a structure that
      // does not match the message.
      const [record] = await h.adapter.metadata.get(AUTH.accountId, 'Email', [
        id,
      ]);
      const { layout: _layout, ...value } = record?.value as Json;
      await h.adapter.metadata.commit(AUTH.accountId, [
        {
          kind: 'update',
          type: 'Email',
          id,
          expectedVersion: record?.version as number,
          value: {
            ...value,
            bodyStructure: { ...value.bodyStructure, subParts: [] },
            textBody: ['9'],
            attachments: [],
          },
        },
      ]);
      expect(await read()).toEqual(current);
      // Properties kept with the email need no second look at the message.
      expect(
        (await h.call('Email/get', { ids: [id], properties: ['subject'] }))
          .list[0].subject,
      ).toBe('Hello');
    });

    it('reads a body exactly as the message holds it', async () => {
      const inbox = await h.mailbox('inbox');
      const bodies: string[] = [];
      for (const raw of [
        'From: a@example.com\r\nSubject: Plain\r\nContent-Type: text/plain\r\n\r\nJust this line.\r\n',
        'From: a@example.com\r\nSubject: Plain\r\nContent-Type: text/plain\r\n\r\nJust this line.',
        'From: a@example.com\r\nSubject: Parts\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nJust this line.\r\n--b--\r\n',
      ]) {
        const blobId = await h.upload(raw);
        const { created } = await h.call('Email/import', {
          emails: { m: { blobId, mailboxIds: { [inbox]: true } } },
        });
        const [email] = (
          await h.call('Email/get', {
            ids: [created.m.id],
            properties: ['textBody', 'bodyValues', 'preview'],
            fetchTextBodyValues: true,
          })
        ).list;
        expect(email.preview).toBe('Just this line.');
        bodies.push(email.bodyValues[email.textBody[0].partId].value);
      }
      // A body that is the whole message keeps the line break it ends with;
      // inside a multipart, the line break before the delimiter is not the part's.
      expect(bodies).toEqual([
        'Just this line.\n',
        'Just this line.',
        'Just this line.',
      ]);
    });

    describe('Email/query', () => {
      let ids: Record<string, string>;
      beforeEach(async () => {
        const deliver = async (
          mailboxId: string,
          options: MessageOptions,
          extra: Json,
        ) => (await h.deliver(mailboxId, options, extra)).id;
        ids = {
          first: await deliver(
            inbox,
            {
              from: 'Alice Smith <alice@example.com>',
              subject: 'Budget review',
              messageId: '<q1@example.com>',
              text: 'short',
            },
            { receivedAt: '2026-10-01T10:00:00Z', keywords: { $seen: true } },
          ),
          second: await deliver(
            inbox,
            {
              from: 'Bob Jones <bob@example.org>',
              to: 'Carol <carol@example.com>',
              subject: 'Re: Budget review',
              inReplyTo: '<q1@example.com>',
              text: 'x'.repeat(2000),
              headers: ['X-Priority: High'],
            },
            {
              receivedAt: '2026-10-02T10:00:00Z',
              keywords: { $flagged: true },
            },
          ),
          third: await deliver(
            inbox,
            {
              from: 'Zed <zed@example.net>',
              subject: 'Holiday photos',
              attachment: {
                name: 'p.txt',
                type: 'text/plain',
                base64: 'cGhvdG8=',
              },
            },
            { receivedAt: '2026-10-03T10:00:00Z' },
          ),
          archived: await deliver(
            archive,
            { from: 'Alice Smith <alice@example.com>', subject: 'Old news' },
            { receivedAt: '2026-09-01T10:00:00Z', keywords: { $seen: true } },
          ),
        };
      });

      const query = async (args: Json) => {
        const result = await h.call('Email/query', args);
        const names = Object.fromEntries(
          Object.entries(ids).map(([key, id]) => [id, key]),
        );
        return result.ids.map((id: string) => names[id]);
      };
      const newestFirst = [{ property: 'receivedAt', isAscending: false }];

      it('filters by mailbox and sorts by date', async () => {
        expect(
          await query({ filter: { inMailbox: inbox }, sort: newestFirst }),
        ).toEqual(['third', 'second', 'first']);
        expect(
          await query({
            filter: { inMailbox: inbox },
            sort: [{ property: 'receivedAt' }],
          }),
        ).toEqual(['first', 'second', 'third']);
        expect(await query({ sort: newestFirst })).toEqual([
          'third',
          'second',
          'first',
          'archived',
        ]);
        expect(
          await query({ filter: { inMailboxOtherThan: [inbox] } }),
        ).toEqual(['archived']);
      });

      it('filters by keyword, date, size and attachment', async () => {
        expect(
          await query({ filter: { hasKeyword: '$seen' }, sort: newestFirst }),
        ).toEqual(['first', 'archived']);
        expect(
          await query({
            filter: { inMailbox: inbox, notKeyword: '$seen' },
            sort: newestFirst,
          }),
        ).toEqual(['third', 'second']);
        expect(
          await query({
            filter: { before: '2026-10-02T10:00:00Z' },
            sort: newestFirst,
          }),
        ).toEqual(['first', 'archived']);
        expect(
          await query({
            filter: { after: '2026-10-02T10:00:00Z' },
            sort: newestFirst,
          }),
        ).toEqual(['third', 'second']);
        expect(await query({ filter: { minSize: 2000 } })).toEqual(['second']);
        expect(
          await query({ filter: { maxSize: 2000 }, sort: newestFirst }),
        ).toEqual(['third', 'first', 'archived']);
        expect(await query({ filter: { hasAttachment: true } })).toEqual([
          'third',
        ]);
      });

      it('filters by addresses, subject and headers', async () => {
        expect(
          await query({ filter: { from: 'alice' }, sort: newestFirst }),
        ).toEqual(['first', 'archived']);
        expect(await query({ filter: { from: 'JONES' } })).toEqual(['second']);
        expect(await query({ filter: { to: 'carol@example.com' } })).toEqual([
          'second',
        ]);
        expect(
          await query({ filter: { subject: 'budget' }, sort: newestFirst }),
        ).toEqual(['second', 'first']);
        expect(await query({ filter: { header: ['X-Priority'] } })).toEqual([
          'second',
        ]);
        expect(
          await query({ filter: { header: ['x-priority', 'high'] } }),
        ).toEqual(['second']);
        expect(
          await query({ filter: { header: ['X-Priority', 'low'] } }),
        ).toEqual([]);
      });

      it('combines conditions with operators', async () => {
        expect(
          await query({
            filter: {
              operator: 'AND',
              conditions: [{ inMailbox: inbox }, { from: 'alice' }],
            },
          }),
        ).toEqual(['first']);
        expect(
          await query({
            filter: {
              operator: 'OR',
              conditions: [{ hasAttachment: true }, { inMailbox: archive }],
            },
            sort: newestFirst,
          }),
        ).toEqual(['third', 'archived']);
        expect(
          await query({
            filter: {
              operator: 'AND',
              conditions: [
                { inMailbox: inbox },
                {
                  operator: 'NOT',
                  conditions: [
                    { hasKeyword: '$seen' },
                    { hasAttachment: true },
                  ],
                },
              ],
            },
          }),
        ).toEqual(['second']);
      });

      it('filters and sorts on thread keywords', async () => {
        expect(
          await query({
            filter: { someInThreadHaveKeyword: '$flagged' },
            sort: newestFirst,
          }),
        ).toEqual(['second', 'first']);
        expect(
          await query({
            filter: { allInThreadHaveKeyword: '$seen' },
            sort: newestFirst,
          }),
        ).toEqual(['archived']);
        expect(
          await query({
            filter: { inMailbox: inbox, noneInThreadHaveKeyword: '$seen' },
          }),
        ).toEqual(['third']);
        expect(
          await query({
            filter: { inMailbox: inbox },
            sort: [
              {
                property: 'someInThreadHaveKeyword',
                keyword: '$flagged',
                isAscending: false,
              },
              { property: 'receivedAt' },
            ],
          }),
        ).toEqual(['first', 'second', 'third']);
      });

      it('sorts by other properties', async () => {
        expect(await query({ sort: [{ property: 'size' }] })).toContain(
          'second',
        );
        expect(
          (
            await query({ sort: [{ property: 'size', isAscending: false }] })
          )[0],
        ).toBe('second');
        expect(
          await query({
            filter: { inMailbox: inbox },
            sort: [{ property: 'from' }],
          }),
        ).toEqual(['first', 'second', 'third']);
        expect(
          await query({
            filter: { inMailbox: inbox },
            sort: [
              { property: 'subject' },
              { property: 'receivedAt', isAscending: false },
            ],
          }),
        ).toEqual(['second', 'first', 'third']);
        expect(
          await query({
            filter: { inMailbox: inbox },
            sort: [
              {
                property: 'hasKeyword',
                keyword: '$flagged',
                isAscending: false,
              },
              { property: 'receivedAt' },
            ],
          }),
        ).toEqual(['second', 'first', 'third']);
      });

      it('collapses threads', async () => {
        expect(
          await query({
            filter: { inMailbox: inbox },
            sort: newestFirst,
            collapseThreads: true,
          }),
        ).toEqual(['third', 'second']);
      });

      it('pages with position, limit and anchor', async () => {
        const page = await h.call('Email/query', {
          sort: newestFirst,
          position: 1,
          limit: 2,
          calculateTotal: true,
        });
        expect(page.ids).toEqual([ids['second'], ids['first']]);
        expect(page.position).toBe(1);
        expect(page.total).toBe(4);
        expect(page).not.toHaveProperty('limit');
        // The state of a query covers emails and threads together.
        expect(page.queryState).toBe(
          `${(await h.call('Email/get', { ids: [] })).state}.${(await h.call('Thread/get', { ids: [] })).state}`,
        );

        expect(await query({ sort: newestFirst, position: -1 })).toEqual([
          'archived',
        ]);
        expect(
          await query({ sort: newestFirst, position: -99, limit: 1 }),
        ).toEqual(['third']);
        expect(await query({ sort: newestFirst, position: 10 })).toEqual([]);
        // Past the end there is nothing, which is not an error.
        expect(
          await h.call('Email/query', { sort: newestFirst, position: 10 }),
        ).toMatchObject({ ids: [], position: 0 });
        expect(await query({ sort: newestFirst, limit: 0 })).toEqual([]);
        expect(
          await query({
            sort: newestFirst,
            anchor: ids['second'],
            anchorOffset: 1,
            limit: 2,
          }),
        ).toEqual(['first', 'archived']);
        expect(
          await query({
            sort: newestFirst,
            anchor: ids['second'],
            anchorOffset: -5,
            limit: 1,
          }),
        ).toEqual(['third']);
        expect((await h.fail('Email/query', { anchor: 'missing' })).type).toBe(
          'anchorNotFound',
        );
      });

      it('rejects what it cannot evaluate', async () => {
        expect(
          (await h.fail('Email/query', { filter: { nope: true } })).type,
        ).toBe('invalidArguments');
        expect(
          (await h.fail('Email/query', { filter: { minSize: 'big' } })).type,
        ).toBe('invalidArguments');
        expect(
          (
            await h.fail('Email/query', {
              filter: { operator: 'XOR', conditions: [] },
            })
          ).type,
        ).toBe('invalidArguments');
        expect(
          (await h.fail('Email/query', { sort: [{ property: 'nope' }] })).type,
        ).toBe('unsupportedSort');
        expect(
          (await h.fail('Email/query', { sort: [{ property: 'hasKeyword' }] }))
            .type,
        ).toBe('invalidArguments');
        expect(
          (await h.fail('Email/queryChanges', { sinceQueryState: 'x' })).type,
        ).toBe('cannotCalculateChanges');
      });
    });

    it('reports Email, Thread and Mailbox changes', async () => {
      const emailState = (await h.call('Email/get', { ids: [] })).state;
      const threadState = (await h.call('Thread/get', { ids: [] })).state;
      const mailboxState = (await h.call('Mailbox/get', { ids: [] })).state;

      const a = await h.deliver(inbox, {
        subject: 'C',
        messageId: '<c1@example.com>',
      });
      const b = await h.deliver(inbox, {
        subject: 'Re: C',
        inReplyTo: '<c1@example.com>',
      });
      const gone = await h.deliver(inbox, { subject: 'Short-lived' });
      await h.call('Email/set', { destroy: [gone.id] });

      const emailChanges = await h.call('Email/changes', {
        sinceState: emailState,
      });
      expect(emailChanges.created).toEqual([a.id, b.id]);
      expect(emailChanges.updated).toEqual([]);
      expect(emailChanges.destroyed).toEqual([]);

      const threadChanges = await h.call('Thread/changes', {
        sinceState: threadState,
      });
      expect(threadChanges.created).toEqual([a.threadId]);
      expect(threadChanges.destroyed).toEqual([]);

      const mailboxChanges = await h.call('Mailbox/changes', {
        sinceState: mailboxState,
      });
      expect(mailboxChanges.created).toEqual([]);
      expect(mailboxChanges.updated).toEqual([inbox]);
      expect([...mailboxChanges.updatedProperties].sort()).toEqual([
        'totalEmails',
        'totalThreads',
        'unreadEmails',
        'unreadThreads',
      ]);

      await h.call('Email/set', {
        update: { [a.id]: { 'keywords/$seen': true } },
      });
      await h.call('Email/set', { destroy: [b.id] });
      const next = await h.call('Email/changes', {
        sinceState: emailChanges.newState,
      });
      expect(next.created).toEqual([]);
      expect(next.updated).toEqual([a.id]);
      expect(next.destroyed).toEqual([b.id]);
      expect(
        (await h.call('Thread/changes', { sinceState: threadChanges.newState }))
          .updated,
      ).toEqual([a.threadId]);

      await h.call('Mailbox/set', { update: { [inbox]: { sortOrder: 3 } } });
      const mixed = await h.call('Mailbox/changes', {
        sinceState: mailboxChanges.newState,
      });
      expect(mixed.updated).toEqual([inbox]);
      expect(mixed.updatedProperties).toBeNull();
    });

    it('stays consistent under concurrent deliveries', async () => {
      const total = 12;
      const results = await Promise.all(
        Array.from({ length: total }, (_, index) =>
          h.deliver(inbox, {
            subject: 'Burst',
            messageId: `<burst-${index}@example.com>`,
            references: '<burst-root@example.com>',
          }),
        ),
      );
      expect(new Set(results.map((result) => result.id)).size).toBe(total);

      const mailbox = await counts(inbox);
      expect(mailbox.totalEmails).toBe(total);
      expect(mailbox.unreadEmails).toBe(total);

      const query = await h.call('Email/query', {
        filter: { inMailbox: inbox },
        collapseThreads: true,
        calculateTotal: true,
      });
      expect(mailbox.totalThreads).toBe(query.total);
      expect(mailbox.unreadThreads).toBe(query.total);

      const threadIds = [...new Set(results.map((result) => result.threadId))];
      const { list } = await h.call('Thread/get', { ids: threadIds });
      expect(list.flatMap((thread: Json) => thread.emailIds).sort()).toEqual(
        results.map((result) => result.id).sort(),
      );
    });

    it('delivers by mailbox role, falling back to the inbox', async () => {
      const raw = encoder.encode(buildMessage({ subject: 'Delivered' }));
      const junk = await h.mailbox('junk');
      const toJunk = await h.server.importMessage(AUTH, raw, {
        mailboxRole: 'junk',
      });
      const toInbox = await h.server.importMessage(AUTH, raw, {
        mailboxRole: 'no-such-role',
      });
      const { list } = await h.call('Email/get', {
        ids: [toJunk.id, toInbox.id],
        properties: ['mailboxIds'],
      });
      expect(list).toEqual([
        { id: toJunk.id, mailboxIds: { [junk]: true } },
        { id: toInbox.id, mailboxIds: { [inbox]: true } },
      ]);

      await expect(h.server.importMessage(AUTH, raw, {})).rejects.toMatchObject(
        {
          error: { type: 'invalidProperties' },
        },
      );
      await expect(
        h.server.importMessage(AUTH, raw, {
          mailboxRole: 'inbox',
          mailboxIds: { [inbox]: true },
        }),
      ).rejects.toMatchObject({ error: { type: 'invalidProperties' } });
    });

    it('imports once per idempotency key, even concurrently', async () => {
      const raw = encoder.encode(
        buildMessage({ subject: 'Once', messageId: '<once@example.com>' }),
      );
      const options = { mailboxRole: 'inbox', idempotencyKey: 'delivery-1' };

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          h.server.importMessage(AUTH, raw, options),
        ),
      );
      const again = await h.server.importMessage(AUTH, raw, options);
      expect(new Set([...results, again].map((result) => result.id)).size).toBe(
        1,
      );
      expect(new Set(results.map((result) => result.threadId)).size).toBe(1);

      expect(await counts(inbox)).toMatchObject({
        totalEmails: 1,
        totalThreads: 1,
      });
      const stored = await h.server.download(
        AUTH,
        AUTH.accountId,
        again.blobId,
      );
      expect(stored).toEqual(raw);

      const other = await h.server.importMessage(AUTH, raw, {
        mailboxRole: 'inbox',
        idempotencyKey: 'delivery-2',
      });
      expect(other.id).not.toBe(again.id);
      expect(other.threadId).toBe(again.threadId);
      expect((await counts(inbox)).totalEmails).toBe(2);
    });

    it('keeps accounts isolated', async () => {
      const email = await h.deliver(inbox);
      const other = { accountId: 'acc2', username: 'other@example.com' };
      await h.server.provisionAccount(other);
      const response = await h.server.handleRequest(
        {
          using: USING,
          methodCalls: [
            ['Email/get', { accountId: 'acc2', ids: [email.id] }, 'a'],
            ['Email/query', { accountId: 'acc2' }, 'b'],
            ['Email/get', { accountId: AUTH.accountId, ids: [email.id] }, 'c'],
          ],
        },
        other,
      );
      expect((response.methodResponses[0]?.[1] as Json).notFound).toEqual([
        email.id,
      ]);
      expect((response.methodResponses[1]?.[1] as Json).ids).toEqual([]);
      expect(response.methodResponses[2]?.[1]).toEqual({
        type: 'accountNotFound',
      });
      expect(await h.server.download(other, 'acc2', email.blobId)).toBeNull();
      expect(
        await h.server.download(other, AUTH.accountId, email.blobId),
      ).toBeNull();
    });

    it('enforces upload limits and account checks on blobs', async () => {
      const server = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        limits: { maxSizeUpload: 10 },
      });
      await expect(
        server.upload(AUTH, AUTH.accountId, new Uint8Array(11), 'text/plain'),
      ).rejects.toMatchObject({ type: REQUEST_ERROR.limit, status: 413 });
      await expect(
        server.upload(AUTH, 'someone-else', new Uint8Array(1), 'text/plain'),
      ).rejects.toMatchObject({ status: 404 });

      const uploaded = await server.upload(
        AUTH,
        AUTH.accountId,
        encoder.encode('hi'),
        'text/plain',
      );
      expect(uploaded).toMatchObject({
        accountId: AUTH.accountId,
        type: 'text/plain',
        size: 2,
      });
      expect(
        decoder.decode(
          (await server.download(AUTH, AUTH.accountId, uploaded.blobId)) ??
            new Uint8Array(),
        ),
      ).toBe('hi');
      expect(await server.download(AUTH, AUTH.accountId, 'missing')).toBeNull();
      expect(
        await server.download(AUTH, AUTH.accountId, '../etc/passwd'),
      ).toBeNull();
    });

    it('enforces object limits', async () => {
      const server = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        limits: { maxObjectsInGet: 2, maxObjectsInSet: 2 },
      });
      const run = async (name: string, args: Json) =>
        (
          await server.handleRequest(
            {
              using: [CAPABILITY_CORE, CAPABILITY_MAIL],
              methodCalls: [
                [name, { accountId: AUTH.accountId, ...args }, 'a'],
              ],
            },
            AUTH,
          )
        ).methodResponses[0]?.[1] as Json;

      expect((await run('Email/get', { ids: ['a', 'b', 'c'] })).type).toBe(
        'requestTooLarge',
      );
      expect((await run('Mailbox/get', { ids: null })).type).toBe(
        'requestTooLarge',
      );
      expect(
        (
          await run('Mailbox/set', {
            create: { a: { name: 'A' }, b: { name: 'B' } },
            destroy: ['x'],
          })
        ).type,
      ).toBe('requestTooLarge');
    });
  });

  describe(`${name}: composing and sending`, () => {
    let h: Harness;
    let drafts: string;
    let sentBox: string;
    beforeEach(async () => {
      h = await createHarness(factory);
      drafts = await h.mailbox('drafts');
      sentBox = await h.mailbox('sent');
    });

    const draft = (overrides: Json = {}) => ({
      mailboxIds: { [drafts]: true },
      keywords: { $draft: true },
      from: [{ name: 'Me Myself', email: 'me@example.com' }],
      to: [{ name: 'Bob', email: 'bob@example.org' }],
      subject: 'Hello Bob',
      bodyValues: { body: { value: 'Hi Bob,\nsee you soon.' } },
      textBody: [{ partId: 'body', type: 'text/plain' }],
      ...overrides,
    });
    const create = async (overrides: Json = {}) => {
      const result = await h.call('Email/set', {
        create: { d: draft(overrides) },
      });
      expect(result.notCreated, JSON.stringify(result.notCreated)).toBeNull();
      return result.created.d;
    };
    const refusal = async (overrides: Json) =>
      (await h.call('Email/set', { create: { d: draft(overrides) } }))
        .notCreated.d;

    it('creates a draft from text, HTML and an uploaded attachment', async () => {
      const blobId = await h.upload('attachment bytes');
      const created = await create({
        cc: [{ name: 'Çarol Ünicode', email: 'carol@example.org' }],
        bcc: [{ email: 'hidden@example.org' }],
        replyTo: [{ email: 'replies@example.com' }],
        subject: 'Relatório — ✓',
        sentAt: '2026-10-07T08:00:00Z',
        inReplyTo: ['parent@example.org'],
        references: ['root@example.org', 'parent@example.org'],
        'header:X-Campaign:asText': 'spring ✓',
        bodyValues: {
          t: { value: 'Plain é' },
          h: { value: '<p>Rich <b>é</b></p>' },
        },
        textBody: [{ partId: 't', type: 'text/plain' }],
        htmlBody: [{ partId: 'h', type: 'text/html' }],
        attachments: [{ blobId, type: 'text/plain', name: 'notes.txt' }],
      });
      expect(Object.keys(created).sort()).toEqual([
        'blobId',
        'id',
        'size',
        'threadId',
      ]);

      const { list } = await h.call('Email/get', {
        ids: [created.id],
        properties: [
          'mailboxIds',
          'keywords',
          'from',
          'to',
          'cc',
          'bcc',
          'replyTo',
          'subject',
          'sentAt',
          'messageId',
          'inReplyTo',
          'references',
          'hasAttachment',
          'textBody',
          'htmlBody',
          'attachments',
          'bodyValues',
          'header:X-Campaign:asText',
        ],
        fetchAllBodyValues: true,
      });
      const email = list[0];
      expect(email).toMatchObject({
        mailboxIds: { [drafts]: true },
        keywords: { $draft: true },
        from: [{ name: 'Me Myself', email: 'me@example.com' }],
        to: [{ name: 'Bob', email: 'bob@example.org' }],
        cc: [{ name: 'Çarol Ünicode', email: 'carol@example.org' }],
        bcc: [{ name: null, email: 'hidden@example.org' }],
        replyTo: [{ name: null, email: 'replies@example.com' }],
        subject: 'Relatório — ✓',
        sentAt: '2026-10-07T08:00:00Z',
        inReplyTo: ['parent@example.org'],
        references: ['root@example.org', 'parent@example.org'],
        hasAttachment: true,
        'header:X-Campaign:asText': 'spring ✓',
      });
      expect(email.messageId).toHaveLength(1);
      expect(email.messageId[0]).toMatch(/@example\.com$/);
      expect(email.bodyValues[email.textBody[0].partId].value.trim()).toBe(
        'Plain é',
      );
      expect(email.bodyValues[email.htmlBody[0].partId].value.trim()).toBe(
        '<p>Rich <b>é</b></p>',
      );
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0]).toMatchObject({
        name: 'notes.txt',
        type: 'text/plain',
      });
      const attachment = await h.server.download(
        AUTH,
        AUTH.accountId,
        email.attachments[0].blobId,
      );
      expect(decoder.decode(attachment ?? new Uint8Array())).toBe(
        'attachment bytes',
      );
    });

    it('accepts an explicit body structure and an empty body', async () => {
      const structured = await create({
        bodyValues: { a: { value: 'one' }, b: { value: '<i>two</i>' } },
        textBody: undefined,
        bodyStructure: {
          type: 'multipart/alternative',
          subParts: [
            { partId: 'a', type: 'text/plain' },
            { partId: 'b', type: 'text/html' },
          ],
        },
      });
      const empty = await create({
        bodyValues: undefined,
        textBody: undefined,
      });
      const { list } = await h.call('Email/get', {
        ids: [structured.id, empty.id],
        properties: ['bodyValues', 'preview'],
        fetchAllBodyValues: true,
      });
      expect(
        Object.values(list[0].bodyValues).map((v: Json) => v.value.trim()),
      ).toEqual(['one', '<i>two</i>']);
      expect(list[1].preview).toBe('');
    });

    it('sets headers in every form, on the message and on its parts', async () => {
      const blobId = await h.upload('%PDF-1.4 not really');
      const created = await create({
        from: undefined,
        to: undefined,
        subject: undefined,
        textBody: undefined,
        'header:From': 'Raw Sender <raw@example.com>',
        'header:Subject:asText': 'Relatório ✓',
        'header:To:asAddresses': [{ name: 'Bob', email: 'bob@example.org' }],
        'header:Cc:asGroupedAddresses': [
          {
            name: 'Team',
            addresses: [{ email: 'a@example.org' }, { email: 'b@example.org' }],
          },
          {
            name: null,
            addresses: [{ name: 'Carol', email: 'carol@example.org' }],
          },
        ],
        'header:In-Reply-To:asMessageIds': ['parent@example.org'],
        'header:Date:asDate': '2026-10-07T09:30:00-04:00',
        'header:List-Unsubscribe:asURLs': [
          'https://example.com/unsubscribe/with-a-fairly-long-path',
          'mailto:leave@example.com',
        ],
        'header:X-Tag:all': ['one', 'two'],
        'header:X-Raw': ' kept as it is',
        bodyStructure: {
          type: 'multipart/mixed',
          'header:X-On-Root': 'belongs to the message',
          subParts: [
            {
              partId: 'body',
              language: ['en', 'pt-BR'],
              location: 'https://example.com/body',
              'header:Content-Description:asText': 'The text',
            },
            {
              blobId,
              type: 'application/pdf',
              name: 'relatório.pdf',
              disposition: 'attachment',
              cid: 'report',
              size: 1,
            },
            { partId: 'data', type: 'application/json', name: 'data.json' },
          ],
        },
        bodyValues: {
          body: { value: 'Hi Bob' },
          data: { value: '{"n":1}' },
        },
      });

      const [email] = (
        await h.call('Email/get', {
          ids: [created.id],
          properties: [
            'from',
            'to',
            'cc',
            'subject',
            'sentAt',
            'inReplyTo',
            'messageId',
            'bodyStructure',
            'textBody',
            'attachments',
            'hasAttachment',
            'bodyValues',
            'header:X-Tag:asRaw:all',
            'header:X-Raw',
            'header:X-On-Root:asText',
            'header:List-Unsubscribe:asURLs',
            'header:Cc:asGroupedAddresses',
            'header:Date',
          ],
          bodyProperties: [
            'partId',
            'type',
            'name',
            'disposition',
            'cid',
            'language',
            'location',
            'charset',
            'size',
            'header:Content-Description:asText',
          ],
          fetchAllBodyValues: true,
        })
      ).list;

      expect(email).toMatchObject({
        from: [{ name: 'Raw Sender', email: 'raw@example.com' }],
        to: [{ name: 'Bob', email: 'bob@example.org' }],
        cc: [
          { name: null, email: 'a@example.org' },
          { name: null, email: 'b@example.org' },
          { name: 'Carol', email: 'carol@example.org' },
        ],
        subject: 'Relatório ✓',
        sentAt: '2026-10-07T09:30:00-04:00',
        inReplyTo: ['parent@example.org'],
        messageId: [expect.stringMatching(/@example\.com$/)],
        hasAttachment: true,
        'header:X-Tag:asRaw:all': [' one', ' two'],
        'header:X-Raw': ' kept as it is',
        'header:X-On-Root:asText': 'belongs to the message',
        'header:List-Unsubscribe:asURLs': [
          'https://example.com/unsubscribe/with-a-fairly-long-path',
          'mailto:leave@example.com',
        ],
        'header:Cc:asGroupedAddresses': [
          {
            name: 'Team',
            addresses: [
              { name: null, email: 'a@example.org' },
              { name: null, email: 'b@example.org' },
            ],
          },
          {
            name: null,
            addresses: [{ name: 'Carol', email: 'carol@example.org' }],
          },
        ],
        'header:Date': ' Wed, 07 Oct 2026 09:30:00 -0400',
      });
      expect(email.bodyStructure).toMatchObject({
        type: 'multipart/mixed',
        subParts: [
          {
            type: 'text/plain',
            charset: 'utf-8',
            language: ['en', 'pt-BR'],
            location: 'https://example.com/body',
            disposition: null,
            'header:Content-Description:asText': 'The text',
          },
          {
            type: 'application/pdf',
            name: 'relatório.pdf',
            disposition: 'attachment',
            cid: 'report',
            size: 19,
          },
          { type: 'application/json', name: 'data.json', disposition: null },
        ],
      });
      expect(email.textBody).toHaveLength(1);
      expect(email.attachments.map((part: Json) => part.type)).toEqual([
        'application/pdf',
        'application/json',
      ]);
      expect(email.bodyValues[email.textBody[0].partId].value).toBe('Hi Bob');
    });

    it('rejects drafts it cannot turn into a message', async () => {
      expect((await refusal({ mailboxIds: undefined })).properties).toEqual([
        'mailboxIds',
      ]);
      expect(
        (await refusal({ mailboxIds: { missing: true } })).properties,
      ).toEqual(['mailboxIds']);
      expect(
        (await refusal({ keywords: { 'bad keyword': true } })).properties,
      ).toEqual(['keywords']);
      expect((await refusal({ receivedAt: 'yesterday' })).properties).toEqual([
        'receivedAt',
      ]);
      expect((await refusal({ id: 'chosen' })).properties).toEqual(['id']);
      expect((await refusal({ threadId: 't', size: 5 })).properties).toEqual([
        'threadId',
        'size',
      ]);
      expect(
        (await refusal({ to: [{ email: 'not-an-address' }] })).properties,
      ).toEqual(['to']);
      expect((await refusal({ to: 'bob@example.org' })).properties).toEqual([
        'to',
      ]);
      expect((await refusal({ subject: 5 })).properties).toEqual(['subject']);
      expect((await refusal({ sentAt: 'soon' })).properties).toEqual([
        'sentAt',
      ]);
      expect((await refusal({ messageId: ['a@b', 'c@d'] })).properties).toEqual(
        ['messageId'],
      );
      expect(
        (
          await refusal({
            textBody: [{ partId: 'missing', type: 'text/plain' }],
          })
        ).properties,
      ).toEqual(['textBody/0/partId']);
      expect(
        (await refusal({ textBody: [{ partId: 'body', type: 'text/html' }] }))
          .properties,
      ).toEqual(['textBody/0/type']);
      expect(
        (await refusal({ textBody: [{ partId: 'body' }, { partId: 'body' }] }))
          .properties,
      ).toEqual(['textBody']);
      expect(
        (await refusal({ textBody: [{ type: 'text/plain' }] })).properties,
      ).toEqual(['textBody/0/partId', 'textBody/0/blobId']);
      // The body is given one way or the other, never both.
      expect(
        (
          await refusal({
            bodyStructure: { partId: 'body', type: 'text/plain' },
          })
        ).properties,
      ).toEqual(['textBody']);
      expect(
        (
          await refusal({
            bodyValues: {
              body: { value: 'x', isTruncated: true, isEncodingProblem: true },
            },
          })
        ).properties,
      ).toEqual([
        'bodyValues/body/isTruncated',
        'bodyValues/body/isEncodingProblem',
      ]);
      // Everything wrong with a part is reported together, by its path.
      const blobId = await h.upload('some bytes');
      expect(
        (
          await refusal({
            textBody: null,
            bodyStructure: {
              type: 'multipart/mixed',
              headers: [{ name: 'X-A', value: 'b' }],
              subParts: [
                { partId: 'body', size: 5, charset: 'utf-8' },
                { partId: 'body', blobId },
                { blobId, 'header:Content-Transfer-Encoding': 'base64' },
                {
                  blobId,
                  type: 'text/plain',
                  'header:Content-Type': 'text/html',
                },
                { blobId, nonsense: true },
                { type: 'multipart/alternative' },
              ],
            },
          })
        ).properties,
      ).toEqual([
        'bodyStructure/headers',
        'bodyStructure/subParts/0/charset',
        'bodyStructure/subParts/0/size',
        'bodyStructure/subParts/1/partId',
        'bodyStructure/subParts/1/blobId',
        'bodyStructure/subParts/2/header:Content-Transfer-Encoding',
        'bodyStructure/subParts/3/header:Content-Type',
        'bodyStructure/subParts/4/nonsense',
        'bodyStructure/subParts/5/subParts',
      ]);
      expect((await refusal({ headers: [] })).properties).toEqual(['headers']);
      expect(
        await refusal({ attachments: [{ blobId: 'gone', type: 'image/png' }] }),
      ).toEqual({
        type: 'blobNotFound',
        notFound: ['gone'],
      });
    });

    it('cannot be used to inject or override headers', async () => {
      expect(
        (await refusal({ subject: 'Hi\r\nBcc: victim@example.org' }))
          .properties,
      ).toEqual(['subject']);
      expect(
        (
          await refusal({
            from: [{ name: 'Me\nX-Evil: 1', email: 'me@example.com' }],
          })
        ).properties,
      ).toEqual(['from']);
      expect((await refusal({ 'header:X-Note': 'a\r\nX-Evil: 1' })).type).toBe(
        'invalidProperties',
      );
      expect(
        (await refusal({ 'header:X-Note:asText': 'a\r\nX-Evil: 1' }))
          .properties,
      ).toEqual(['header:X-Note']);
      // A header already set through its own property cannot be set again, in any form.
      for (const header of [
        'header:From',
        'header:from:asAddresses',
        'header:Subject:asText',
        'header:To',
      ]) {
        expect(
          (
            await refusal({
              [header]: header.endsWith('asAddresses') ? [] : 'x',
            })
          ).properties,
          header,
        ).toEqual([header]);
      }
      // Content headers describe a part, not the message.
      expect(
        (await refusal({ 'header:Content-Type': 'x' })).properties,
      ).toEqual(['header:Content-Type']);
      // A form the header does not allow, and a value of the wrong shape.
      expect(
        (await refusal({ 'header:Date:asAddresses': [] })).properties,
      ).toEqual(['header:Date:asAddresses']);
      expect(
        (await refusal({ 'header:X-Note:asAddresses': 'x' })).properties,
      ).toEqual(['header:X-Note']);
      expect(
        (await refusal({ 'header:X-Note': ['a', 'b'] })).properties,
      ).toEqual(['header:X-Note']);
      expect((await refusal({ 'header:Bad Name': 'x' })).properties).toEqual([
        'header:Bad Name',
      ]);
      expect((await counts(drafts)).totalEmails).toBe(0);
    });

    const counts = async (mailboxId: string) =>
      (
        await h.call('Mailbox/get', {
          ids: [mailboxId],
          properties: ['totalEmails'],
        })
      ).list[0];

    it('lists the identities and refuses to change them', async () => {
      const { list, state, notFound } = await h.call('Identity/get', {
        ids: null,
      });
      expect(notFound).toEqual([]);
      expect(list).toEqual([
        {
          id: 'me',
          name: 'Me Myself',
          email: 'me@example.com',
          replyTo: null,
          bcc: null,
          textSignature: '',
          htmlSignature: '',
          mayDelete: false,
        },
        expect.objectContaining({
          id: 'team',
          email: '*@team.example.com',
          name: '',
        }),
        expect.objectContaining({
          id: 'catchall',
          email: 'me@catch.example.com',
        }),
      ]);
      // Which other addresses an identity may send as is the server's business, not the client's.
      expect(JSON.stringify(list)).not.toContain('allowedFrom');
      expect(JSON.stringify(list)).not.toContain('legacy@old.example.com');
      expect(
        await h.call('Identity/get', {
          ids: ['team', 'nope'],
          properties: ['email'],
        }),
      ).toMatchObject({
        list: [{ id: 'team', email: '*@team.example.com' }],
        notFound: ['nope'],
      });

      expect(
        await h.call('Identity/changes', { sinceState: state }),
      ).toMatchObject({
        created: [],
        updated: [],
        destroyed: [],
        newState: state,
      });
      expect(
        (await h.fail('Identity/changes', { sinceState: 'old' })).type,
      ).toBe('cannotCalculateChanges');

      // Which identities exist is the server's decision.
      const changed = await h.call('Identity/set', {
        create: { n: { email: 'other@example.com' } },
        destroy: ['team'],
      });
      expect(changed.notCreated.n.type).toBe('forbidden');
      expect(changed.notDestroyed.team.type).toBe('forbidden');
      expect(changed.newState).toBe(state);
    });

    it('lets a user change how an identity presents them, and nothing else', async () => {
      const read = async (id = 'me') =>
        (await h.call('Identity/get', { ids: [id] })).list[0];
      const before = await h.call('Identity/get', {});

      const result = await h.call('Identity/set', {
        ifInState: before.state,
        update: {
          me: {
            name: 'Me, at work',
            replyTo: [{ name: 'Replies', email: 'replies@example.com' }],
            textSignature: 'Regards,\nMe',
            htmlSignature: '<p>Regards,<br>Me</p>',
            // Sent back as received, which is allowed.
            id: 'me',
            email: 'me@example.com',
            mayDelete: false,
          },
          team: { bcc: [{ email: 'archive@example.com' }] },
          nope: { name: 'x' },
        },
      });
      expect(result.updated).toEqual({ me: null, team: null });
      expect(result.notUpdated).toEqual({ nope: { type: 'notFound' } });
      expect(result.oldState).toBe(before.state);
      expect(result.newState).not.toBe(before.state);
      expect(await read()).toEqual({
        id: 'me',
        name: 'Me, at work',
        email: 'me@example.com',
        replyTo: [{ name: 'Replies', email: 'replies@example.com' }],
        bcc: null,
        textSignature: 'Regards,\nMe',
        htmlSignature: '<p>Regards,<br>Me</p>',
        mayDelete: false,
      });
      expect((await read('team')).bcc).toEqual([
        { email: 'archive@example.com' },
      ]);
      expect((await h.call('Identity/get', {})).state).toBe(result.newState);
      expect(
        (await h.fail('Identity/changes', { sinceState: before.state })).type,
      ).toBe('cannotCalculateChanges');

      // A later change keeps what was set before, and can clear a value.
      await h.call('Identity/set', {
        update: { me: { name: 'Me again', replyTo: null } },
      });
      expect(await read()).toMatchObject({
        name: 'Me again',
        replyTo: null,
        textSignature: 'Regards,\nMe',
      });

      // The address, and what may be sent as it, stay as the server set them.
      for (const [property, value] of [
        ['email', 'someone-else@example.org'],
        ['id', 'other'],
        ['mayDelete', true],
        ['allowedFrom', ['*@example.org']],
        ['name', 'Two\r\nLines'],
        ['name', 7],
        ['replyTo', [{ email: 'not an address' }]],
        ['bcc', 'archive@example.com'],
        ['textSignature', null],
      ] as Array<[string, Json]>) {
        const refused = await h.call('Identity/set', {
          update: { me: { [property]: value } },
        });
        expect(refused.notUpdated?.me, property).toEqual({
          type: 'invalidProperties',
          properties: [property],
        });
      }
      expect(await read()).toMatchObject({
        name: 'Me again',
        email: 'me@example.com',
      });
      expect(
        (
          await h.fail('Identity/set', {
            ifInState: before.state,
            update: { me: { name: 'Late' } },
          })
        ).type,
      ).toBe('stateMismatch');

      // Sending still goes by the address the server allows, whatever the name says.
      const other = await h.server.handleRequest(
        {
          using: USING,
          methodCalls: [['Identity/get', { accountId: 'acc2' }, 'a']],
        },
        { accountId: 'acc2', username: 'other@example.com' },
      );
      expect(
        (other.methodResponses[0]?.[1] as Json).list.map(
          (identity: Json) => identity.name,
        ),
      ).toEqual(['Me Myself', '', '']);
    });

    it('creates, sends and files a message in one request', async () => {
      const responses = await h.request([
        [
          'Email/set',
          {
            create: {
              d: draft({
                cc: [{ email: 'carol@example.org' }],
                bcc: [
                  { email: 'hidden@example.org' },
                  { email: 'bob@example.org' },
                ],
              }),
            },
          },
        ],
        [
          'EmailSubmission/set',
          {
            create: { s: { identityId: 'me', emailId: '#d' } },
            onSuccessUpdateEmail: {
              '#s': {
                [`mailboxIds/${drafts}`]: null,
                [`mailboxIds/${sentBox}`]: true,
                'keywords/$draft': null,
                'keywords/$seen': true,
              },
            },
          },
        ],
      ]);
      expect(responses.map((response) => [response[0], response[2]])).toEqual([
        ['Email/set', 'c0'],
        ['EmailSubmission/set', 'c1'],
        ['Email/set', 'c1'],
      ]);
      const emailId = (responses[0]?.[1] as Json).created.d.id;
      const submission = (responses[1]?.[1] as Json).created.s;
      expect(submission).toMatchObject({
        undoStatus: 'final',
        deliveryStatus: {
          'bob@example.org': {
            smtpReply: '250 Accepted',
            delivered: 'queued',
            displayed: 'unknown',
          },
        },
        envelope: {
          mailFrom: { email: 'me@example.com', parameters: null },
          rcptTo: [
            { email: 'bob@example.org', parameters: null },
            { email: 'carol@example.org', parameters: null },
            { email: 'hidden@example.org', parameters: null },
          ],
        },
      });
      expect((responses[2]?.[1] as Json).updated).toEqual({ [emailId]: null });

      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.envelope).toEqual({
        mailFrom: 'me@example.com',
        rcptTo: ['bob@example.org', 'carol@example.org', 'hidden@example.org'],
        tags: { account: AUTH.accountId, submission: submission.id },
      });
      const wire = h.sent[0]?.message ?? '';
      expect(wire).toContain('Subject: Hello Bob');
      expect(wire).toContain('To: "Bob" <bob@example.org>');
      expect(wire).toContain('Cc: carol@example.org');
      // A header line, not the letters: a random message id may well contain "bcc".
      expect(wire).not.toMatch(/^bcc:/im);
      expect(wire).not.toContain('hidden@example.org');
      expect(wire).toContain('see you soon.');

      const { list } = await h.call('Email/get', {
        ids: [emailId],
        properties: ['mailboxIds', 'keywords', 'bcc'],
      });
      expect(list[0]).toEqual({
        id: emailId,
        mailboxIds: { [sentBox]: true },
        keywords: { $seen: true },
        // The stored copy keeps its Bcc so the sender can see who got it.
        bcc: [
          { name: null, email: 'hidden@example.org' },
          { name: null, email: 'bob@example.org' },
        ],
      });

      const stored = await h.call('EmailSubmission/get', {
        ids: [submission.id],
      });
      expect(stored.list[0]).toMatchObject({
        id: submission.id,
        identityId: 'me',
        emailId,
        threadId: (responses[0]?.[1] as Json).created.d.threadId,
        sendAt: submission.sendAt,
      });
    });

    it('can delete the draft after sending', async () => {
      const created = await create();
      const responses = await h.request([
        [
          'EmailSubmission/set',
          {
            create: { s: { identityId: 'me', emailId: created.id } },
            onSuccessDestroyEmail: ['#s'],
          },
        ],
      ]);
      expect((responses[1]?.[1] as Json).destroyed).toEqual([created.id]);
      expect(h.sent).toHaveLength(1);
      expect(
        (await h.call('Email/get', { ids: [created.id] })).notFound,
      ).toEqual([created.id]);
    });

    it('only sends from addresses the identity covers', async () => {
      const submit = async (
        identityId: string,
        overrides: Json,
        submission: Json = {},
      ) => {
        const email = await create(overrides);
        const result = await h.call('EmailSubmission/set', {
          create: { s: { identityId, emailId: email.id, ...submission } },
        });
        return result.notCreated?.s ?? result.created.s;
      };

      expect(
        (await submit('me', { from: [{ email: 'boss@example.com' }] })).type,
      ).toBe('forbiddenFrom');
      // Setting the header in raw form, or on the outermost body part, changes nothing.
      expect(
        (
          await submit('me', {
            from: undefined,
            'header:From': 'The Boss <boss@example.com>',
          })
        ).type,
      ).toBe('forbiddenFrom');
      expect(
        (
          await submit('me', {
            from: undefined,
            textBody: undefined,
            bodyStructure: {
              partId: 'body',
              'header:From:asAddresses': [{ email: 'boss@example.com' }],
            },
          })
        ).type,
      ).toBe('forbiddenFrom');
      expect(
        (
          await submit('me', {
            'header:Sender': 'boss@example.com',
          })
        ).type,
      ).toBe('forbiddenFrom');
      expect(
        (await submit('me', { from: [{ email: 'me@example.com.evil.org' }] }))
          .type,
      ).toBe('forbiddenFrom');
      expect(
        (
          await submit('me', {
            from: [{ email: 'me@example.com' }, { email: 'other@example.com' }],
          })
        ).type,
      ).toBe('forbiddenFrom');
      expect(
        (
          await submit('team', {
            from: [{ email: 'x@team.example.com.evil.org' }],
          })
        ).type,
      ).toBe('forbiddenFrom');
      expect(
        (await submit('team', { from: [{ email: 'x@sub.team.example.com' }] }))
          .type,
      ).toBe('forbiddenFrom');
      expect((await submit('me', { from: undefined })).type).toBe(
        'invalidEmail',
      );
      expect(h.sent).toHaveLength(0);

      expect(
        (await submit('me', { from: [{ email: 'ME@Example.com' }] }))
          .undoStatus,
      ).toBe('final');
      expect(
        (await submit('team', { from: [{ email: 'Anyone@Team.Example.com' }] }))
          .undoStatus,
      ).toBe('final');
      expect(h.sent.map((entry) => entry.envelope.mailFrom)).toEqual([
        'ME@Example.com',
        'Anyone@Team.Example.com',
      ]);

      expect(
        (
          await submit(
            'me',
            {},
            {
              envelope: {
                mailFrom: { email: 'boss@example.com' },
                rcptTo: [{ email: 'bob@example.org' }],
              },
            },
          )
        ).type,
      ).toBe('forbiddenMailFrom');
      const explicit = await submit(
        'me',
        {},
        {
          envelope: {
            mailFrom: { email: 'me@example.com' },
            rcptTo: [
              { email: 'only@example.org' },
              { email: 'only@example.org' },
            ],
          },
        },
      );
      expect(explicit).not.toHaveProperty('envelope');
      expect(h.sent.at(-1)?.envelope.rcptTo).toEqual(['only@example.org']);
    });

    it('lets an identity send as the further addresses it is allowed, and never as a wildcard', async () => {
      const submit = async (from: string) => {
        const email = await create({ from: [{ email: from }] });
        const result = await h.call('EmailSubmission/set', {
          create: { s: { identityId: 'catchall', emailId: email.id } },
        });
        return result.notCreated?.s?.type ?? 'sent';
      };
      expect(await submit('me@catch.example.com')).toBe('sent');
      expect(await submit('anything@catch.example.com')).toBe('sent');
      expect(await submit('legacy@old.example.com')).toBe('sent');
      expect(await submit('other@old.example.com')).toBe('forbiddenFrom');
      expect(await submit('me@example.com')).toBe('forbiddenFrom');
      // A client that copies the pattern into From must be stopped: such mail is treated as spam.
      expect(await submit('*@catch.example.com')).toBe('invalidEmail');
      expect(await submit('*@team.example.com')).toBe('invalidEmail');
      expect(h.sent).toHaveLength(3);
    });

    it('threads a reply that refers to the id the transport gave the message', async () => {
      const sent = await create({ subject: 'Dinner on Friday?' });
      await h.call('EmailSubmission/set', {
        create: { s: { identityId: 'me', emailId: sent.id } },
      });
      expect(h.sent).toHaveLength(1);

      const inbox = await h.mailbox('inbox');
      const reply = await h.deliver(
        inbox,
        {
          from: 'Bob <bob@example.org>',
          subject: 'Re: Dinner on Friday?',
          inReplyTo: '<relay-1@relay.example>',
          references: '<relay-1@relay.example>',
        },
        { receivedAt: '2040-01-01T00:00:00Z' },
      );
      expect(reply.threadId).toBe(sent.threadId);
      expect(
        (await h.call('Thread/get', { ids: [sent.threadId] })).list[0].emailIds,
      ).toEqual([sent.id, reply.id]);

      // The substituted id is bookkeeping: the message keeps its own id, and clients see only that.
      const { list } = await h.call('Email/get', {
        ids: [sent.id],
        properties: ['messageId'],
      });
      expect(list[0].messageId).toHaveLength(1);
      expect(list[0].messageId[0]).not.toContain('relay');
      expect(
        (
          await h.fail('Email/get', {
            ids: [sent.id],
            properties: ['transportMessageIds'],
          })
        ).type,
      ).toBe('invalidArguments');
    });

    it('rejects submissions that cannot be delivered', async () => {
      const email = await create();
      const noRecipients = await create({ to: undefined });
      const tooMany = await create({
        to: Array.from({ length: 51 }, (_, index) => ({
          email: `user${index}@example.org`,
        })),
      });
      const result = await h.call('EmailSubmission/set', {
        create: {
          identity: { identityId: 'nope', emailId: email.id },
          email: { identityId: 'me', emailId: 'missing' },
          reference: { identityId: 'me', emailId: '#never-created' },
          extra: {
            identityId: 'me',
            emailId: email.id,
            sendAt: '2030-01-01T00:00:00Z',
          },
          none: { identityId: 'me', emailId: noRecipients.id },
          many: { identityId: 'me', emailId: tooMany.id },
          bad: {
            identityId: 'me',
            emailId: email.id,
            envelope: {
              mailFrom: { email: 'me@example.com' },
              rcptTo: [{ email: 'nope' }],
            },
          },
          malformed: {
            identityId: 'me',
            emailId: email.id,
            envelope: { rcptTo: [] },
          },
        },
      });
      expect(result.created).toBeNull();
      expect(result.notCreated.identity.properties).toEqual(['identityId']);
      expect(result.notCreated.email.properties).toEqual(['emailId']);
      expect(result.notCreated.reference.properties).toEqual(['emailId']);
      expect(result.notCreated.extra.properties).toEqual(['sendAt']);
      expect(result.notCreated.none.type).toBe('noRecipients');
      expect(result.notCreated.many).toEqual({
        type: 'tooManyRecipients',
        maxRecipients: 50,
      });
      expect(result.notCreated.bad).toEqual({
        type: 'invalidRecipients',
        invalidRecipients: ['nope'],
      });
      expect(result.notCreated.malformed.properties).toEqual(['envelope']);
      expect(h.sent).toHaveLength(0);
    });

    it('reports a refusal by the transport and leaves the draft alone', async () => {
      const created = await create();
      h.rejectNext('Email address is not verified');
      const responses = await h.request([
        [
          'EmailSubmission/set',
          {
            create: { s: { identityId: 'me', emailId: created.id } },
            onSuccessDestroyEmail: ['#s'],
          },
        ],
      ]);
      expect(responses).toHaveLength(1);
      expect((responses[0]?.[1] as Json).notCreated.s).toEqual({
        type: 'forbiddenToSend',
        description: 'Email address is not verified',
      });
      expect(
        (await h.call('Email/get', { ids: [created.id] })).notFound,
      ).toEqual([]);
      expect((await h.call('EmailSubmission/query', {})).ids).toEqual([]);
    });

    it('keeps a record of submissions that can be queried and removed', async () => {
      const state = (await h.call('EmailSubmission/get', { ids: [] })).state;
      const first = await create({ subject: 'One' });
      const second = await create({ subject: 'Two' });
      const submit = async (emailId: string) =>
        (
          await h.call('EmailSubmission/set', {
            create: { s: { identityId: 'me', emailId } },
          })
        ).created.s.id;
      const a = await submit(first.id);
      const b = await submit(second.id);

      expect(
        (await h.call('EmailSubmission/changes', { sinceState: state }))
          .created,
      ).toEqual([a, b]);
      expect(
        (
          await h.call('EmailSubmission/query', {
            filter: { emailIds: [second.id] },
          })
        ).ids,
      ).toEqual([b]);
      expect(
        (
          await h.call('EmailSubmission/query', {
            filter: { identityIds: ['me'], undoStatus: 'final' },
            calculateTotal: true,
          })
        ).total,
      ).toBe(2);
      expect(
        (
          await h.call('EmailSubmission/query', {
            filter: { undoStatus: 'pending' },
          })
        ).ids,
      ).toEqual([]);
      expect(
        (await h.fail('EmailSubmission/query', { filter: { nope: 1 } })).type,
      ).toBe('invalidArguments');
      expect(
        (
          await h.fail('EmailSubmission/query', {
            sort: [{ property: 'nope' }],
          })
        ).type,
      ).toBe('unsupportedSort');

      const changed = await h.call('EmailSubmission/set', {
        update: {
          [a]: { undoStatus: 'canceled' },
          absent: { undoStatus: 'canceled' },
        },
        destroy: [b, 'missing'],
      });
      expect(changed.notUpdated[a].type).toBe('cannotUnsend');
      expect(changed.notUpdated.absent.type).toBe('notFound');
      expect(changed.destroyed).toEqual([b]);
      expect(changed.notDestroyed.missing.type).toBe('notFound');
      expect(
        (await h.call('EmailSubmission/get', { ids: [a, b] })).notFound,
      ).toEqual([b]);
    });

    it('records delivery outcomes reported after sending', async () => {
      const email = await create({
        to: [{ email: 'bob@example.org' }, { email: 'Carol@Example.org' }],
      });
      const { id } = (
        await h.call('EmailSubmission/set', {
          create: { s: { identityId: 'me', emailId: email.id } },
        })
      ).created.s;
      const state = (await h.call('EmailSubmission/get', { ids: [] })).state;
      const status = async () =>
        (
          await h.call('EmailSubmission/get', {
            ids: [id],
            properties: ['deliveryStatus'],
          })
        ).list[0].deliveryStatus;

      expect(
        await h.server.recordDelivery(AUTH, id, {
          'BOB@example.org': { delivered: 'yes', smtpReply: '250 2.0.0 OK' },
          'carol@example.org': {
            delivered: 'no',
            smtpReply: '550 5.1.1 No such user',
          },
          'stranger@example.org': { delivered: 'yes' },
        }),
      ).toBe(true);
      expect(await status()).toEqual({
        'bob@example.org': {
          smtpReply: '250 2.0.0 OK',
          delivered: 'yes',
          displayed: 'unknown',
        },
        'Carol@Example.org': {
          smtpReply: '550 5.1.1 No such user',
          delivered: 'no',
          displayed: 'unknown',
        },
      });
      expect(
        (await h.call('EmailSubmission/changes', { sinceState: state }))
          .updated,
      ).toEqual([id]);

      // A late or repeated report never undoes a known outcome.
      const settled = (await h.call('EmailSubmission/get', { ids: [] })).state;
      await h.server.recordDelivery(AUTH, id, {
        'bob@example.org': { delivered: 'queued', smtpReply: '451 try later' },
        'carol@example.org': { delivered: 'yes', smtpReply: '250 OK' },
      });
      await h.server.recordDelivery(AUTH, id, {
        'bob@example.org': { delivered: 'yes', smtpReply: '250 2.0.0 OK' },
      });
      expect((await status())['bob@example.org'].delivered).toBe('yes');
      expect((await status())['Carol@Example.org'].delivered).toBe('no');
      expect((await h.call('EmailSubmission/get', { ids: [] })).state).toBe(
        settled,
      );

      // Delivered, then bounced after all: the failure wins.
      await h.server.recordDelivery(AUTH, id, {
        'bob@example.org': { delivered: 'no', smtpReply: '550 mailbox gone' },
      });
      expect((await status())['bob@example.org']).toMatchObject({
        delivered: 'no',
        smtpReply: '550 mailbox gone',
      });

      expect(await h.server.recordDelivery(AUTH, 'missing', {})).toBe(false);
      expect(
        await h.server.recordDelivery(
          { accountId: 'acc2', username: 'x' },
          id,
          {
            'bob@example.org': { delivered: 'yes' },
          },
        ),
      ).toBe(false);
    });

    it('offers no sending methods when no transport is configured', async () => {
      const server = createJmapServer({ storage: h.adapter, urls: URLS });
      expect(Object.keys(server.getSession(AUTH).capabilities)).not.toContain(
        CAPABILITY_SUBMISSION,
      );
      await expect(
        server.handleRequest({ using: USING, methodCalls: [] }, AUTH),
      ).rejects.toMatchObject({ type: REQUEST_ERROR.unknownCapability });
      const response = await server.handleRequest(
        {
          using: [CAPABILITY_CORE, CAPABILITY_MAIL],
          methodCalls: [['Identity/get', { accountId: AUTH.accountId }, 'a']],
        },
        AUTH,
      );
      expect(response.methodResponses[0]?.[1]).toEqual({
        type: 'unknownMethod',
      });
    });
  });

  describe(`${name}: push`, () => {
    let h: Harness;
    let server: JmapServer;
    let now: Date;
    /** Every request the server made to a push service, with the body as sent. */
    let pushed: Array<{
      url: string;
      headers: Record<string, string>;
      body: Uint8Array;
    }>;
    /** The status the fake push service answers with, and any headers. */
    let answer: { status: number; headers?: Record<string, string> };
    let stateChanges: Array<{ accountId: string; types: string[] }>;

    beforeEach(async () => {
      h = await createHarness(factory);
      now = new Date('2026-10-07T12:00:00Z');
      pushed = [];
      answer = { status: 201 };
      stateChanges = [];
      server = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        onStateChange: (accountId, types) =>
          stateChanges.push({ accountId, types }),
        push: {
          now: () => now,
          maxSubscriptions: 3,
          fetch: async (input, init) => {
            pushed.push({
              url: String(input),
              headers: init?.headers as Record<string, string>,
              body: init?.body as Uint8Array,
            });
            if (answer.status === 0) throw new Error('connection refused');
            return new Response(null, answer);
          },
        },
      });
    });

    const call = async (name: string, args: Json): Promise<Json> => {
      const response = await server.handleRequest(
        { using: [CAPABILITY_CORE], methodCalls: [[name, args, 'c']] },
        AUTH,
      );
      return response.methodResponses[0];
    };
    const set = async (args: Json): Promise<Json> => {
      const [name, result] = await call('PushSubscription/set', args);
      expect(name, JSON.stringify(result)).toBe('PushSubscription/set');
      return result;
    };
    const json = (index: number): Json =>
      JSON.parse(decoder.decode(pushed[index]?.body));
    /** Creates a subscription and confirms it, as a client that received the verification would. */
    const subscribe = async (overrides: Json = {}): Promise<string> => {
      const before = pushed.length;
      const { created, notCreated } = await set({
        create: {
          s: {
            deviceClientId: 'device-1',
            url: 'https://push.example.net/v1/abc',
            ...overrides,
          },
        },
      });
      expect(notCreated, JSON.stringify(notCreated)).toBeNull();
      const verification = overrides.keys
        ? decryptPush(pushed[before]?.body as Uint8Array)
        : json(before);
      const { updated } = await set({
        update: {
          [created.s.id]: { verificationCode: verification.verificationCode },
        },
      });
      expect(updated).toEqual({ [created.s.id]: null });
      pushed.length = before;
      return created.s.id;
    };

    it('verifies a new subscription before pushing anything to it', async () => {
      const { created } = await set({
        create: {
          s: {
            deviceClientId: 'device-1',
            url: 'https://push.example.net/v1/abc?device=1',
            types: ['Email', 'Mailbox'],
          },
        },
      });
      const id = created.s.id;
      // The longest lifetime the server allows, since none was asked for.
      expect(created.s).toEqual({ id, expires: '2026-11-06T12:00:00Z' });

      expect(pushed).toHaveLength(1);
      expect(pushed[0]?.url).toBe('https://push.example.net/v1/abc?device=1');
      expect(pushed[0]?.headers).toEqual({
        TTL: '86400',
        'Content-Type': 'application/json',
      });
      const verification = json(0);
      expect(verification).toEqual({
        '@type': 'PushVerification',
        pushSubscriptionId: id,
        verificationCode: expect.stringMatching(/^[A-Za-z0-9]{20,}$/),
      });

      // Until the client echoes the code, the URL hears nothing more.
      const inbox = await h.mailbox('inbox');
      await h.deliver(inbox);
      expect(await server.pushStateChange(AUTH.accountId)).toEqual({
        sent: 0,
        failed: 0,
        removed: 0,
      });
      expect(pushed).toHaveLength(1);

      const wrong = await set({ update: { [id]: { verificationCode: 'no' } } });
      expect(wrong.notUpdated[id]).toMatchObject({
        type: 'invalidProperties',
        properties: ['verificationCode'],
      });
      expect((await call('PushSubscription/get', { ids: [id] }))[1]).toEqual({
        list: [
          {
            id,
            deviceClientId: 'device-1',
            verificationCode: null,
            expires: '2026-11-06T12:00:00Z',
            types: ['Email', 'Mailbox'],
          },
        ],
        notFound: [],
      });

      const right = await set({
        update: { [id]: { verificationCode: verification.verificationCode } },
      });
      expect(right.updated).toEqual({ [id]: null });
      expect(
        (await call('PushSubscription/get', { ids: null }))[1].list[0]
          .verificationCode,
      ).toBe(verification.verificationCode);

      expect(await server.pushStateChange(AUTH.accountId)).toEqual({
        sent: 1,
        failed: 0,
        removed: 0,
      });
      expect(pushed).toHaveLength(2);
      expect(pushed[1]?.headers).toEqual({
        TTL: '86400',
        Topic: id,
        'Content-Type': 'application/json',
      });
      // Only the types the client asked for, each with the state its /get would return.
      expect(json(1)).toEqual({
        '@type': 'StateChange',
        changed: {
          [AUTH.accountId]: {
            Email: (await h.call('Email/get', { ids: [] })).state,
            Mailbox: (await h.call('Mailbox/get', { ids: [] })).state,
          },
        },
      });
    });

    it('pushes only the types that changed, to subscriptions that want them', async () => {
      await subscribe({ deviceClientId: 'all', types: null });
      await subscribe({
        deviceClientId: 'delivery-only',
        url: 'https://push.example.net/v1/delivery',
        types: ['EmailDelivery', 'CalendarEvent'],
      });

      expect(await server.pushStateChange(AUTH.accountId, ['Thread'])).toEqual({
        sent: 1,
        failed: 0,
        removed: 0,
      });
      expect(Object.keys(json(0).changed[AUTH.accountId])).toEqual(['Thread']);

      pushed.length = 0;
      await server.pushStateChange(AUTH.accountId);
      expect(pushed).toHaveLength(2);
      const byUrl = Object.fromEntries(
        pushed.map((push, index) => [push.url, json(index)]),
      );
      expect(
        Object.keys(
          byUrl['https://push.example.net/v1/abc'].changed[AUTH.accountId],
        ).sort(),
      ).toEqual([
        'Email',
        'EmailDelivery',
        'EmailSubmission',
        'Mailbox',
        'Thread',
      ]);
      expect(
        Object.keys(
          byUrl['https://push.example.net/v1/delivery'].changed[AUTH.accountId],
        ),
      ).toEqual(['EmailDelivery']);

      // Types that are never pushed, and other accounts, reach nobody.
      pushed.length = 0;
      await server.pushStateChange(AUTH.accountId, ['PushSubscription']);
      await server.pushStateChange('acc2');
      expect(pushed).toHaveLength(0);
    });

    it('moves the EmailDelivery state only when mail arrives from outside', async () => {
      const state = () =>
        h.adapter.metadata.getState(AUTH.accountId, 'EmailDelivery');
      const initial = await state();
      const inbox = await h.mailbox('inbox');

      // A message the client uploads is not a delivery.
      await h.deliver(inbox);
      expect(await state()).toBe(initial);

      const raw = (subject: string) =>
        encoder.encode(buildMessage({ subject }));
      await server.importMessage(AUTH, raw('first'), {
        mailboxRole: 'inbox',
        delivery: true,
        idempotencyKey: 'delivery-1',
      });
      const first = await state();
      expect(first).not.toBe(initial);
      expect(first).toBe((await h.call('Email/get', { ids: [] })).state);
      expect(stateChanges.at(-1)).toEqual({
        accountId: AUTH.accountId,
        types: expect.arrayContaining(['Email', 'Thread', 'EmailDelivery']),
      });

      // The same delivery again changes nothing; another one does.
      await server.importMessage(AUTH, raw('first'), {
        mailboxRole: 'inbox',
        delivery: true,
        idempotencyKey: 'delivery-1',
      });
      expect(await state()).toBe(first);
      await Promise.all(
        ['second', 'third', 'fourth'].map((subject) =>
          server.importMessage(AUTH, raw(subject), {
            mailboxRole: 'inbox',
            delivery: true,
          }),
        ),
      );
      expect(await state()).not.toBe(first);
      expect((await h.call('Email/query', {})).ids).toHaveLength(5);
    });

    it('encrypts pushes for a subscription that has keys', async () => {
      const id = await subscribe({ keys: RECEIVER_KEYS });
      await server.pushStateChange(AUTH.accountId, ['Email']);

      expect(pushed).toHaveLength(1);
      expect(pushed[0]?.headers).toEqual({
        TTL: '86400',
        Topic: id,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
      });
      expect(decoder.decode(pushed[0]?.body)).not.toContain('StateChange');
      expect(decryptPush(pushed[0]?.body as Uint8Array)).toEqual({
        '@type': 'StateChange',
        changed: { [AUTH.accountId]: { Email: expect.any(String) } },
      });
    });

    it('never returns the URL or the keys', async () => {
      const id = await subscribe({ keys: RECEIVER_KEYS });
      const [, all] = await call('PushSubscription/get', {});
      expect(Object.keys(all.list[0]).sort()).toEqual([
        'deviceClientId',
        'expires',
        'id',
        'types',
        'verificationCode',
      ]);
      expect(
        (
          await call('PushSubscription/get', {
            ids: [id, 'missing'],
            properties: ['deviceClientId'],
          })
        )[1],
      ).toEqual({
        list: [{ id, deviceClientId: 'device-1' }],
        notFound: ['missing'],
      });
      for (const property of ['url', 'keys']) {
        expect(
          await call('PushSubscription/get', { properties: [property] }),
        ).toEqual([
          'error',
          expect.objectContaining({ type: 'forbidden' }),
          'c',
        ]);
      }
      expect(await call('PushSubscription/get', { properties: ['x'] })).toEqual(
        ['error', expect.objectContaining({ type: 'invalidArguments' }), 'c'],
      );
      // Subscriptions belong to the user who made them.
      const other = await server.handleRequest(
        {
          using: [CAPABILITY_CORE],
          methodCalls: [['PushSubscription/get', { ids: [id] }, 'c']],
        },
        { accountId: 'acc2', username: 'other@example.com' },
      );
      expect(other.methodResponses[0]?.[1]).toEqual({
        list: [],
        notFound: [id],
      });
    });

    it('refuses subscriptions it could not safely push to', async () => {
      const refusal = async (overrides: Json) =>
        (
          await set({
            create: {
              s: {
                deviceClientId: 'device-1',
                url: 'https://push.example.net/x',
                ...overrides,
              },
            },
          })
        ).notCreated?.s;

      for (const url of [
        'http://push.example.net/x',
        'https://127.0.0.1/x',
        'https://2130706433/x',
        'https://0x7f.1/x',
        'https://[::1]/x',
        'https://169.254.169.254/latest/meta-data',
        'https://localhost/x',
        'https://printer.local/x',
        'https://db.internal./x',
        'https://intranet/x',
        'https://user:secret@push.example.net/x',
        'ftp://push.example.net/x',
        '/relative',
        `https://push.example.net/${'x'.repeat(3000)}`,
        42,
        null,
      ]) {
        expect(await refusal({ url }), String(url)).toMatchObject({
          type: 'invalidProperties',
          properties: ['url'],
        });
      }
      for (const [property, value] of [
        ['deviceClientId', ''],
        ['deviceClientId', 7],
        ['verificationCode', 'guess'],
        ['expires', '2026-10-07T11:59:59Z'],
        ['expires', 'tomorrow'],
        ['types', 'Email'],
        ['types', [1]],
        ['keys', { p256dh: RECEIVER_KEYS.p256dh }],
        ['keys', { p256dh: 'AAAA', auth: RECEIVER_KEYS.auth }],
        ['keys', 'secret'],
        ['id', 'chosen-by-client'],
      ] as Array<[string, Json]>) {
        expect(
          await refusal({ [property]: value }),
          `${property}=${JSON.stringify(value)}`,
        ).toMatchObject({ type: 'invalidProperties', properties: [property] });
      }
      // Nothing was stored, and nothing was sent anywhere.
      expect((await call('PushSubscription/get', {}))[1].list).toEqual([]);
      expect(pushed).toHaveLength(0);
    });

    it('limits lifetime and number, and lets a client renew, narrow and remove', async () => {
      const id = await subscribe({ expires: '2026-10-08T12:00:00.000Z' });
      const read = async () =>
        (await call('PushSubscription/get', { ids: [id] }))[1].list[0];
      expect((await read()).expires).toBe('2026-10-08T12:00:00Z');

      // Further than the server allows: shortened, and the client is told.
      const renewed = await set({
        update: { [id]: { expires: '2030-01-01T00:00:00Z', types: ['Email'] } },
      });
      expect(renewed.updated).toEqual({
        [id]: { expires: '2026-11-06T12:00:00Z' },
      });
      expect(await read()).toMatchObject({
        expires: '2026-11-06T12:00:00Z',
        types: ['Email'],
        // Renewing does not require verifying again.
        verificationCode: expect.any(String),
      });

      const bad = await set({
        update: {
          [id]: { url: 'https://elsewhere.example.net/' },
          missing: { types: null },
        },
        destroy: ['absent'],
      });
      expect(bad.notUpdated[id]).toMatchObject({
        type: 'invalidProperties',
        properties: ['url'],
      });
      expect(bad.notUpdated.missing).toEqual({ type: 'notFound' });
      expect(bad.notDestroyed.absent).toEqual({ type: 'notFound' });

      await subscribe({ deviceClientId: 'device-2' });
      await subscribe({ deviceClientId: 'device-3' });
      const full = await set({
        create: {
          s: { deviceClientId: 'device-4', url: 'https://push.example.net/4' },
        },
      });
      expect(full.notCreated.s).toMatchObject({ type: 'overQuota' });

      const removed = await set({ destroy: [id] });
      expect(removed.destroyed).toEqual([id]);
      expect(await read()).toBeUndefined();
      await subscribe({ deviceClientId: 'device-4' });
    });

    it('stops pushing to subscriptions that expired or are no longer known', async () => {
      const shortLived = await subscribe({
        deviceClientId: 'short',
        expires: '2026-10-08T12:00:00Z',
      });
      const longLived = await subscribe({ deviceClientId: 'long' });
      const ids = async () =>
        (await call('PushSubscription/get', {}))[1].list.map(
          (subscription: Json) => subscription.id,
        );

      now = new Date('2026-10-08T12:00:00Z');
      expect(await ids()).toEqual([longLived]);
      expect(
        (await set({ update: { [shortLived]: { expires: null } } })).notUpdated[
          shortLived
        ],
      ).toEqual({ type: 'notFound' });
      expect(await server.pushStateChange(AUTH.accountId)).toEqual({
        sent: 1,
        failed: 0,
        removed: 1,
      });
      expect(
        await h.adapter.metadata.list(AUTH.accountId, 'PushSubscription'),
      ).toHaveLength(1);

      // The push service says the subscription is gone: forget it.
      answer = { status: 410 };
      expect(await server.pushStateChange(AUTH.accountId)).toEqual({
        sent: 0,
        failed: 0,
        removed: 1,
      });
      expect(await ids()).toEqual([]);
    });

    it('survives push services that fail, and slows down when asked', async () => {
      const id = await subscribe();

      for (const status of [500, 301, 0]) {
        answer = { status };
        expect(
          await server.pushStateChange(AUTH.accountId),
          String(status),
        ).toEqual({ sent: 0, failed: 1, removed: 0 });
      }
      expect(pushed).toHaveLength(3);

      answer = { status: 429, headers: { 'Retry-After': '120' } };
      expect(await server.pushStateChange(AUTH.accountId)).toMatchObject({
        failed: 1,
      });
      answer = { status: 201 };
      pushed.length = 0;
      now = new Date(now.getTime() + 119_000);
      expect(await server.pushStateChange(AUTH.accountId)).toEqual({
        sent: 0,
        failed: 0,
        removed: 0,
      });
      expect(pushed).toHaveLength(0);
      now = new Date(now.getTime() + 2_000);
      expect(await server.pushStateChange(AUTH.accountId)).toMatchObject({
        sent: 1,
      });
      // None of this is visible to the client as a change to its subscription.
      expect(
        (await call('PushSubscription/get', { ids: [id] }))[1].list[0],
      ).not.toHaveProperty('pausedUntil');

      // A subscription whose verification never arrived stays, unverified.
      answer = { status: 0 };
      const { created } = await set({
        create: {
          s: { deviceClientId: 'device-2', url: 'https://down.example.net/' },
        },
      });
      expect(created.s.id).toEqual(expect.any(String));
    });

    it('reports every write to onStateChange, and nothing for reads', async () => {
      stateChanges.length = 0;
      await server.handleRequest(
        {
          using: [CAPABILITY_CORE, CAPABILITY_MAIL],
          methodCalls: [
            ['Mailbox/get', { accountId: AUTH.accountId }, 'a'],
            [
              'Mailbox/set',
              {
                accountId: AUTH.accountId,
                create: { m: { name: 'Projects' } },
              },
              'b',
            ],
          ],
        },
        AUTH,
      );
      expect(stateChanges).toEqual([
        { accountId: AUTH.accountId, types: ['Mailbox'] },
      ]);
      // A server without push answers the call and does nothing.
      expect(await h.server.pushStateChange(AUTH.accountId)).toEqual({
        sent: 0,
        failed: 0,
        removed: 0,
      });
    });
  });

  describe(`${name}: full-text search`, () => {
    let h: Harness;
    let inbox: string;
    let archive: string;
    let ids: Record<string, string>;
    beforeEach(async () => {
      h = await createHarness(factory);
      inbox = await h.mailbox('inbox');
      archive = await h.mailbox('archive');
      ids = {};
      const deliver = async (
        key: string,
        box: string,
        options: MessageOptions,
      ) => (ids[key] = (await h.deliver(box, options)).id);
      await deliver('budget', inbox, {
        from: 'Jörg Müller <jorg@example.org>',
        to: 'Me <me@example.com>',
        subject: 'Quarterly numbers',
        text: 'The budget review is on Thursday.\nPlease bring the café receipts & <notes>.',
      });
      await deliver('party', inbox, {
        from: 'Carol <carol@example.org>',
        cc: 'Dave Budgetson <dave@example.net>',
        subject: 'Surprise party',
        html: '<html><head><style>.budget { color: red }</style></head><body><p>Cake &amp; candles at <b>eight</b>&#33; R&eacute;sum&#xE9;s welcome.</p><!-- budget --></body></html>',
        htmlOnly: true,
      });
      await deliver('report', archive, {
        from: 'Reports <reports@example.org>',
        subject: 'Monthly report',
        text: 'See the attached file.',
        attachment: {
          name: 'budget-2026.txt',
          type: 'text/plain',
          base64: Buffer.from('Travel costs were under the forecast.').toString(
            'base64',
          ),
        },
      });
    });

    const search = async (filter: Json, extra: Json = {}) =>
      (await h.call('Email/query', { filter, ...extra })).ids as string[];
    const names = async (filter: Json, extra: Json = {}) => {
      const found = await search(filter, extra);
      return Object.keys(ids)
        .filter((key) => found.includes(ids[key] as string))
        .sort();
    };

    it('finds text in the body', async () => {
      expect(await names({ body: 'thursday' })).toEqual(['budget']);
      expect(await names({ body: 'THURSDAY review' })).toEqual(['budget']);
      expect(await names({ body: 'cafe' })).toEqual(['budget']);
      expect(await names({ body: 'review friday' })).toEqual([]);
      // Words from the subject or the sender are not in the body.
      expect(await names({ body: 'quarterly' })).toEqual([]);
      expect(await names({ body: 'jorg' })).toEqual([]);
    });

    it('finds text in the headers as well with a text filter', async () => {
      expect(await names({ text: 'quarterly' })).toEqual(['budget']);
      expect(await names({ text: 'jorg' })).toEqual(['budget']);
      expect(await names({ text: 'carol@example.org' })).toEqual(['party']);
      // Cc, a sender name, the body, and an attachment's file name.
      expect(await names({ text: 'budget' })).toEqual([
        'budget',
        'party',
        'report',
      ]);
      // The words may be spread over the subject and the body.
      expect(await names({ text: 'numbers thursday' })).toEqual(['budget']);
      expect(await names({ text: 'numbers eight' })).toEqual([]);
    });

    it('treats quoted text as a phrase and other words as beginnings', async () => {
      expect(await names({ body: '"budget review"' })).toEqual(['budget']);
      expect(await names({ body: '"review budget"' })).toEqual([]);
      expect(await names({ body: "'bring the cafe'" })).toEqual(['budget']);
      expect(await names({ body: 'thurs rev' })).toEqual(['budget']);
      expect(await names({ body: '"thurs"' })).toEqual([]);
      expect(await names({ body: 'ursday' })).toEqual([]);
    });

    it('searches the text of HTML bodies, not their markup', async () => {
      expect(await names({ body: 'cake candles eight' })).toEqual(['party']);
      expect(await names({ body: 'resumes' })).toEqual(['party']);
      expect(await names({ body: '"at eight"' })).toEqual(['party']);
      for (const markup of ['style', 'color', 'html', 'amp', 'budget']) {
        expect(await names({ body: markup }), markup).toEqual(
          markup === 'budget' ? ['budget'] : [],
        );
      }
    });

    it('searches text attachments', async () => {
      expect(await names({ body: 'forecast' })).toEqual(['report']);
      expect(await names({ text: '"travel costs"' })).toEqual(['report']);
    });

    it('combines with other conditions, operators, sorting and paging', async () => {
      expect(await names({ text: 'budget', inMailbox: inbox })).toEqual([
        'budget',
        'party',
      ]);
      expect(await names({ text: 'budget', inMailbox: archive })).toEqual([
        'report',
      ]);
      expect(
        await names({
          operator: 'AND',
          conditions: [
            { text: 'budget' },
            { operator: 'NOT', conditions: [{ body: 'thursday' }] },
          ],
        }),
      ).toEqual(['party', 'report']);
      expect(
        await names({
          operator: 'OR',
          conditions: [{ body: 'candles' }, { body: 'forecast' }],
        }),
      ).toEqual(['party', 'report']);
      expect(
        await search(
          { text: 'budget' },
          { sort: [{ property: 'subject' }], position: 1, limit: 1 },
        ),
      ).toEqual([ids['budget']]);
      const total = await h.call('Email/query', {
        filter: { text: 'budget' },
        calculateTotal: true,
        limit: 1,
      });
      expect(total.total).toBe(3);
      expect(await names({ text: '' })).toEqual(['budget', 'party', 'report']);
      expect((await h.fail('Email/query', { filter: { text: 7 } })).type).toBe(
        'invalidArguments',
      );
    });

    it('follows messages as they are created, sent and destroyed', async () => {
      const drafts = await h.mailbox('drafts');
      const { created } = await h.call('Email/set', {
        create: {
          d: {
            mailboxIds: { [drafts]: true },
            from: [{ email: 'me@example.com' }],
            to: [{ email: 'bob@example.org' }],
            subject: 'Itinerary',
            bodyValues: { b: { value: 'Flight to Zürich leaves at noon.' } },
            textBody: [{ partId: 'b', type: 'text/plain' }],
          },
        },
      });
      expect(await search({ body: 'zurich noon' })).toEqual([created.d.id]);

      await h.call('Email/set', { destroy: [created.d.id, ids['budget']] });
      expect(await search({ body: 'zurich' })).toEqual([]);
      expect(await names({ text: 'budget' })).toEqual(['party', 'report']);
      // The searchable text went with the messages.
      expect(
        (await h.adapter.metadata.list(AUTH.accountId, 'EmailText'))
          .map((record) => record.id)
          .sort(),
      ).toEqual([ids['party'], ids['report']].sort());

      // Emptying a mailbox removes the text of what was only there.
      await h.call('Mailbox/set', {
        destroy: [archive],
        onDestroyRemoveEmails: true,
      });
      expect(
        (await h.adapter.metadata.list(AUTH.accountId, 'EmailText')).map(
          (record) => record.id,
        ),
      ).toEqual([ids['party']]);
    });

    it('catches up on messages stored before search existed', async () => {
      // As left by an older version: emails without their searchable text, and
      // text left behind by an email that is gone.
      const texts = await h.adapter.metadata.list(AUTH.accountId, 'EmailText');
      await h.adapter.metadata.commit(AUTH.accountId, [
        ...texts.map((record) => ({
          kind: 'destroy' as const,
          type: 'EmailText',
          id: record.id,
        })),
      ]);
      await h.adapter.metadata.commit(AUTH.accountId, [
        {
          kind: 'create',
          type: 'EmailText',
          id: 'em-gone',
          value: { v: 1, body: ' budget ', names: ' ' },
        },
        {
          kind: 'create',
          type: 'EmailText',
          id: ids['party'] as string,
          value: { v: 0, body: ' outdated ', names: ' ' },
        },
      ]);

      // A search limited to one mailbox only catches up on that mailbox.
      expect(await names({ body: 'forecast', inMailbox: archive })).toEqual([
        'report',
      ]);
      expect(
        (await h.adapter.metadata.list(AUTH.accountId, 'EmailText'))
          .map((record) => record.id)
          .sort(),
      ).toEqual([ids['party'], ids['report'], 'em-gone'].sort());

      expect(await names({ text: 'budget' })).toEqual([
        'budget',
        'party',
        'report',
      ]);
      expect(await names({ body: 'candles' })).toEqual(['party']);
      expect(await names({ body: 'outdated' })).toEqual([]);
      const after = await h.adapter.metadata.list(AUTH.accountId, 'EmailText');
      expect(after.map((record) => record.id).sort()).toEqual(
        Object.values(ids).sort(),
      );
      expect(after.every((record) => record.value['v'] === 1)).toBe(true);

      // None of that is a change to the mail itself.
      const state = (await h.call('Email/get', { ids: [] })).state;
      await names({ text: 'budget' });
      expect((await h.call('Email/get', { ids: [] })).state).toBe(state);
    });

    it('returns highlighted snippets with SearchSnippet/get', async () => {
      const snippets = async (filter: Json, emailIds: string[]) =>
        h.call('SearchSnippet/get', { filter, emailIds });

      const result = await snippets({ text: 'budget quarter' }, [
        ids['budget'] as string,
        'missing',
        ids['party'] as string,
      ]);
      expect(result).toEqual({
        accountId: AUTH.accountId,
        list: [
          {
            emailId: ids['budget'],
            subject: '<mark>Quarterly</mark> numbers',
            preview:
              'The <mark>budget</mark> review is on Thursday. Please bring the café receipts &amp; &lt;notes&gt;.',
          },
          // It matched through the Cc header, which has no snippet.
          { emailId: ids['party'], subject: null, preview: null },
        ],
        notFound: ['missing'],
      });

      // An HTML body is shown as text; a subject filter marks only the subject.
      expect(
        (await snippets({ body: '"at eight" cake' }, [ids['party'] as string]))
          .list[0],
      ).toEqual({
        emailId: ids['party'],
        subject: null,
        preview:
          '<mark>Cake</mark> &amp; candles <mark>at eight</mark> ! Résumés welcome.',
      });
      const bySubject = await snippets(
        {
          operator: 'AND',
          conditions: [
            { subject: 'party' },
            { inMailbox: inbox },
            { operator: 'NOT', conditions: [{ body: 'cake' }] },
          ],
        },
        [ids['party'] as string],
      );
      expect(bySubject).toMatchObject({
        list: [
          {
            subject: 'Surprise <mark>party</mark>',
            // What a match must not contain is not highlighted.
            preview: null,
          },
        ],
        notFound: null,
      });

      // Without anything to look for there is nothing to highlight.
      for (const filter of [null, { hasKeyword: '$seen' }]) {
        expect(
          (await snippets(filter, [ids['budget'] as string])).list,
        ).toEqual([{ emailId: ids['budget'], subject: null, preview: null }]);
      }

      expect(
        (
          await h.fail('SearchSnippet/get', {
            filter: { nope: 1 },
            emailIds: [],
          })
        ).type,
      ).toBe('invalidArguments');
      expect(
        (
          await h.fail('SearchSnippet/get', {
            emailIds: Array.from({ length: 501 }, (_, index) => `e${index}`),
          })
        ).type,
      ).toBe('requestTooLarge');
    });

    it('keeps a snippet of a long body within 255 octets', async () => {
      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing. ';
      const { id } = await h.deliver(inbox, {
        subject: 'Long one',
        text: `${filler.repeat(30)}The überraschung is ready. ${filler.repeat(30)}`,
      });
      const { list } = await h.call('SearchSnippet/get', {
        filter: { body: 'uberraschung' },
        emailIds: [id],
      });
      expect(encoder.encode(list[0].preview).length).toBeLessThanOrEqual(255);
      expect(list[0].preview).toContain('<mark>überraschung</mark> is ready.');
    });
  });

  describe(`${name}: queryChanges`, () => {
    let h: Harness;
    let inbox: string;
    let archive: string;
    beforeEach(async () => {
      h = await createHarness(factory);
      inbox = await h.mailbox('inbox');
      archive = await h.mailbox('archive');
    });

    /**
     * Brings a cached result list up to date the way RFC 8620 §5.6 tells
     * clients to: take out everything removed, then put in everything added,
     * lowest index first.
     */
    const applyChanges = (cached: string[], changes: Json): string[] => {
      const result = cached.filter((id) => !changes.removed.includes(id));
      for (const { id, index } of changes.added) result.splice(index, 0, id);
      return result;
    };

    /** Checks that queryChanges turns the old results of a query into its new ones. */
    const follow = async (method: string, args: Json) => {
      const before = await h.call(`${method}/query`, args);
      expect(before.canCalculateChanges).toBe(true);
      return async (label: string) => {
        const now = await h.call(`${method}/query`, args);
        const changes = await h.call(`${method}/queryChanges`, {
          ...args,
          sinceQueryState: before.queryState,
          calculateTotal: true,
        });
        expect(changes.oldQueryState).toBe(before.queryState);
        expect(changes.newQueryState, label).toBe(now.queryState);
        expect(changes.total, label).toBe(now.ids.length);
        expect(
          changes.added.map((item: Json) => item.index),
          label,
        ).toEqual(
          [...changes.added.map((item: Json) => item.index)].sort(
            (a: number, b: number) => a - b,
          ),
        );
        expect(applyChanges(before.ids, changes), label).toEqual(now.ids);
        return changes;
      };
    };

    it('reports nothing when nothing changed', async () => {
      await h.deliver(inbox, { subject: 'Only one' });
      for (const [method, args] of [
        ['Email', { filter: { inMailbox: inbox } }],
        ['Mailbox', { sort: [{ property: 'name' }] }],
        ['EmailSubmission', {}],
      ] as Array<[string, Json]>) {
        const check = await follow(method, args);
        const changes = await check(method);
        expect(changes.removed).toEqual([]);
        expect(changes.added).toEqual([]);
        expect(changes).not.toHaveProperty('nonsense');
      }
      const { queryState } = await h.call('Email/query', {});
      expect(
        await h.call('Email/queryChanges', { sinceQueryState: queryState }),
      ).not.toHaveProperty('total');
    });

    it('follows emails arriving, changing, moving and going', async () => {
      const subjects = ['delta', 'alpha', 'charlie', 'bravo'];
      const ids: Record<string, string> = {};
      for (const [index, subject] of subjects.entries()) {
        ids[subject] = (
          await h.deliver(
            inbox,
            { subject },
            { receivedAt: `2026-10-0${index + 1}T10:00:00Z` },
          )
        ).id;
      }

      const queries: Array<[string, Json]> = [
        [
          'everything, newest first',
          { sort: [{ property: 'receivedAt', isAscending: false }] },
        ],
        [
          'the inbox by subject',
          { filter: { inMailbox: inbox }, sort: [{ property: 'subject' }] },
        ],
        [
          'unread only',
          { filter: { notKeyword: '$seen' }, sort: [{ property: 'subject' }] },
        ],
        [
          'flagged first',
          {
            sort: [
              {
                property: 'hasKeyword',
                keyword: '$flagged',
                isAscending: false,
              },
              { property: 'subject' },
            ],
          },
        ],
        ['a text search', { filter: { text: 'alpha' } }],
      ];
      const checks = await Promise.all(
        queries.map(async ([label, args]) => ({
          label,
          check: await follow('Email', args),
        })),
      );

      // One of each kind of change, then all queries are brought up to date.
      ids['echo'] = (
        await h.deliver(
          inbox,
          { subject: 'echo alpha' },
          { receivedAt: '2026-10-05T10:00:00Z' },
        )
      ).id;
      await h.call('Email/set', {
        update: {
          [ids['alpha'] as string]: { 'keywords/$seen': true },
          [ids['charlie'] as string]: { 'keywords/$flagged': true },
          [ids['bravo'] as string]: { mailboxIds: { [archive]: true } },
        },
        destroy: [ids['delta'] as string],
      });

      for (const { label, check } of checks) {
        const changes = await check(label);
        // Whatever was destroyed is always among the removed.
        expect(changes.removed, label).toContain(ids['delta']);
      }

      const [, inboxArgs] = queries[1] as [string, Json];
      const { queryState } = await h.call('Email/query', inboxArgs);
      await h.deliver(inbox, { subject: 'foxtrot' });
      const one = await h.call('Email/queryChanges', {
        ...inboxArgs,
        sinceQueryState: queryState,
      });
      // Something new cannot have been in the old results, so it is only added.
      expect(one.removed).toEqual([]);
      expect(one.added).toEqual([{ id: expect.any(String), index: 3 }]);
    });

    it('follows threads when the query depends on them', async () => {
      const first = await h.deliver(
        inbox,
        {
          subject: 'Plans',
          messageId: '<p1@example.com>',
        },
        { receivedAt: '2026-10-01T10:00:00Z' },
      );
      const other = await h.deliver(
        inbox,
        { subject: 'Other' },
        { receivedAt: '2026-10-02T10:00:00Z' },
      );

      const collapsed = await follow('Email', {
        collapseThreads: true,
        sort: [{ property: 'receivedAt', isAscending: false }],
      });
      const allFlagged = await follow('Email', {
        filter: { allInThreadHaveKeyword: '$flagged' },
      });
      const someFlagged = await follow('Email', {
        filter: { someInThreadHaveKeyword: '$flagged' },
      });

      // A reply joins the thread and becomes what stands for it; the first is
      // flagged, which changes what both thread-wide conditions say about the reply.
      const reply = await h.deliver(
        inbox,
        {
          subject: 'Re: Plans',
          messageId: '<p2@example.com>',
          inReplyTo: '<p1@example.com>',
        },
        { receivedAt: '2026-10-03T10:00:00Z' },
      );
      expect(reply.threadId).toBe(first.threadId);
      await h.call('Email/set', {
        update: { [first.id]: { 'keywords/$flagged': true } },
      });

      const changes = await collapsed('collapsed');
      // The first message did change here, but it would have to go even if it
      // had not: it no longer stands for its thread.
      expect(changes.removed).toContain(first.id);
      expect(changes.added.map((item: Json) => item.id)).toEqual([reply.id]);
      await allFlagged('all flagged');
      expect((await someFlagged('some flagged')).added).toHaveLength(2);

      // Destroying the unflagged reply makes the thread all flagged, although
      // the message that now matches did not change.
      const afterReply = await follow('Email', {
        filter: { allInThreadHaveKeyword: '$flagged' },
      });
      await h.call('Email/set', { destroy: [reply.id] });
      const again = await afterReply('after the reply went');
      expect(again.added).toEqual([{ id: first.id, index: 0 }]);
      expect(again.removed).not.toContain(other.id);
    });

    it('follows mailboxes, flat and as a tree', async () => {
      const flat = await follow('Mailbox', {
        filter: { hasAnyRole: false },
        sort: [{ property: 'name' }],
      });
      const tree = await follow('Mailbox', {
        sort: [{ property: 'name' }],
        sortAsTree: true,
        filterAsTree: true,
        filter: { isSubscribed: true },
      });

      const { created } = await h.call('Mailbox/set', {
        create: {
          work: { name: 'Work' },
          clients: { name: 'Clients', parentId: '#work' },
          aside: { name: 'Aside' },
        },
      });
      const first = await flat('created');
      expect(first.removed).toEqual([]);
      expect(first.added.map((item: Json) => item.id)).toEqual([
        created.aside.id,
        created.clients.id,
        created.work.id,
      ]);
      await tree('created, as a tree');

      const later = await follow('Mailbox', { sort: [{ property: 'name' }] });
      const laterTree = await follow('Mailbox', {
        sort: [{ property: 'name' }],
        sortAsTree: true,
        filterAsTree: true,
        filter: { isSubscribed: true },
      });
      await h.call('Mailbox/set', {
        update: {
          [created.aside.id]: { name: 'Zebra' },
          // Hiding a parent hides its children from a tree-filtered list.
          [created.work.id]: { isSubscribed: false },
        },
        destroy: [archive],
      });
      const second = await later('renamed and destroyed');
      expect(second.removed).toContain(archive);
      const asTree = await laterTree('as a tree');
      expect(asTree.removed).toContain(created.clients.id);
      expect(asTree.added.map((item: Json) => item.id)).not.toContain(
        created.clients.id,
      );

      // Mail arriving changes a mailbox's counts, and so the mailbox.
      const counts = await follow('Mailbox', { sort: [{ property: 'name' }] });
      await h.deliver(inbox);
      const third = await counts('mail arrived');
      expect(third.removed).toEqual([inbox]);
      expect(third.added).toEqual([{ id: inbox, index: expect.any(Number) }]);
    });

    it('follows submissions', async () => {
      const drafts = await h.mailbox('drafts');
      const draft = async (subject: string) =>
        (
          await h.call('Email/set', {
            create: {
              d: {
                mailboxIds: { [drafts]: true },
                from: [{ email: 'me@example.com' }],
                to: [{ email: 'bob@example.org' }],
                subject,
                bodyValues: { b: { value: 'Hi' } },
                textBody: [{ partId: 'b' }],
              },
            },
          })
        ).created.d.id;
      const check = await follow('EmailSubmission', {
        sort: [{ property: 'sentAt' }],
      });
      const { created } = await h.call('EmailSubmission/set', {
        create: { s: { identityId: 'me', emailId: await draft('One') } },
      });
      const changes = await check('one sent');
      expect(changes.removed).toEqual([]);
      expect(changes.added).toEqual([{ id: created.s.id, index: 0 }]);
    });

    it('limits how much it reports, and refuses states it does not know', async () => {
      for (let index = 0; index < 4; index++) {
        await h.deliver(inbox, { subject: `m${index}` });
      }
      const { queryState } = await h.call('Email/query', {});
      for (let index = 0; index < 3; index++) {
        await h.deliver(inbox, { subject: `n${index}` });
      }
      expect(
        (
          await h.fail('Email/queryChanges', {
            sinceQueryState: queryState,
            maxChanges: 2,
          })
        ).type,
      ).toBe('tooManyChanges');
      expect(
        (
          await h.call('Email/queryChanges', {
            sinceQueryState: queryState,
            maxChanges: 3,
          })
        ).added,
      ).toHaveLength(3);

      for (const [method, state] of [
        ['Email', 'x'],
        ['Email', '1'],
        ['Email', '999999.0'],
        ['Email', '1.2.3'],
        ['Mailbox', 'x'],
        ['Mailbox', '999999'],
        ['EmailSubmission', 'not-a-state'],
      ] as Array<[string, string]>) {
        expect(
          (await h.fail(`${method}/queryChanges`, { sinceQueryState: state }))
            .type,
          `${method} ${state}`,
        ).toBe('cannotCalculateChanges');
      }
      expect(
        (
          await h.fail('Email/queryChanges', {
            sinceQueryState: queryState,
            filter: { nope: 1 },
          })
        ).type,
      ).toBe('invalidArguments');
    });
  });

  describe(`${name}: parsing and copying`, () => {
    let h: Harness;
    let inbox: string;
    beforeEach(async () => {
      h = await createHarness(factory);
      inbox = await h.mailbox('inbox');
    });

    const forwarded = [
      'From: Carol <carol@example.org>',
      'To: me@example.com',
      'Subject: Fwd: the original',
      'Content-Type: multipart/mixed; boundary=outer',
      '',
      '--outer',
      'Content-Type: text/plain',
      '',
      'See the attached message.',
      '--outer',
      'Content-Type: message/rfc822',
      'Content-Disposition: attachment; filename=original.eml',
      '',
      'From: Dave <dave@example.net>',
      'To: carol@example.org',
      'Subject: The original',
      'Date: Mon, 05 Oct 2026 09:00:00 +0100',
      'Message-ID: <orig@example.net>',
      'Content-Type: multipart/mixed; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Original body',
      '--inner',
      'Content-Type: text/plain; name=notes.txt',
      'Content-Disposition: attachment; filename=notes.txt',
      '',
      'Attached notes',
      '--inner--',
      '--outer--',
      '',
    ].join('\r\n');

    it('parses a message that is attached to another, without importing it', async () => {
      const blobId = await h.upload(forwarded);
      const { created } = await h.call('Email/import', {
        emails: { m: { blobId, mailboxIds: { [inbox]: true } } },
      });
      const [outer] = (
        await h.call('Email/get', {
          ids: [created.m.id],
          properties: ['attachments'],
        })
      ).list;
      const attached = outer.attachments[0];
      expect(attached).toMatchObject({
        type: 'message/rfc822',
        name: 'original.eml',
      });
      const before = (await h.call('Email/get', { ids: [] })).state;

      const result = await h.call('Email/parse', {
        blobIds: [attached.blobId, 'missing', blobId],
        fetchTextBodyValues: true,
      });
      expect(result.notFound).toEqual(['missing']);
      expect(result.notParsable).toBeNull();
      expect(Object.keys(result.parsed)).toEqual([attached.blobId, blobId]);

      const inner = result.parsed[attached.blobId];
      // The properties RFC 8621 §4.9 lists as the default, and no others.
      expect(Object.keys(inner).sort()).toEqual([
        'attachments',
        'bcc',
        'bodyValues',
        'cc',
        'from',
        'hasAttachment',
        'htmlBody',
        'inReplyTo',
        'messageId',
        'preview',
        'references',
        'replyTo',
        'sender',
        'sentAt',
        'subject',
        'textBody',
        'to',
      ]);
      expect(inner).toMatchObject({
        from: [{ name: 'Dave', email: 'dave@example.net' }],
        subject: 'The original',
        sentAt: '2026-10-05T09:00:00+01:00',
        messageId: ['orig@example.net'],
        hasAttachment: true,
        preview: 'Original body',
      });
      expect(inner.bodyValues[inner.textBody[0].partId].value).toBe(
        'Original body',
      );
      // A part of the attached message can be fetched like any other blob.
      const notes = inner.attachments[0];
      expect(notes.name).toBe('notes.txt');
      expect(
        decoder.decode(
          (await h.server.download(
            AUTH,
            AUTH.accountId,
            notes.blobId,
          )) as Uint8Array,
        ),
      ).toBe('Attached notes');

      // What only an email in the mail store has is null.
      const [, , whole] = [0, 0, result.parsed[blobId]];
      expect(whole.subject).toBe('Fwd: the original');
      const state = await h.call('Email/parse', {
        blobIds: [attached.blobId],
        properties: [
          'id',
          'mailboxIds',
          'keywords',
          'receivedAt',
          'threadId',
          'blobId',
          'size',
          'header:Subject:asText',
        ],
      });
      expect(state.parsed[attached.blobId]).toEqual({
        id: null,
        mailboxIds: null,
        keywords: null,
        receivedAt: null,
        threadId: null,
        blobId: attached.blobId,
        size: expect.any(Number),
        'header:Subject:asText': 'The original',
      });
      // Nothing was stored.
      expect((await h.call('Email/get', { ids: [] })).state).toBe(before);
      expect((await h.call('Email/query', {})).ids).toHaveLength(1);
    });

    it('says which blobs are not messages', async () => {
      const notMail = await h.upload('\r\njust some bytes, no header fields');
      const result = await h.call('Email/parse', { blobIds: [notMail] });
      expect(result).toMatchObject({
        parsed: null,
        notParsable: [notMail],
        notFound: null,
      });
      expect(
        (await h.fail('Email/parse', { blobIds: [], properties: ['nope'] }))
          .type,
      ).toBe('invalidArguments');
    });

    it('refuses to read a header in a form it cannot take', async () => {
      const { id } = await h.deliver(inbox);
      for (const property of [
        'header:From:asDate',
        'header:Date:asAddresses',
        'header:Subject:asMessageIds',
        'header:Message-ID:asURLs',
      ]) {
        expect(
          (await h.fail('Email/get', { ids: [id], properties: [property] }))
            .type,
          property,
        ).toBe('invalidArguments');
        expect(
          (await h.fail('Email/parse', { blobIds: [], properties: [property] }))
            .type,
        ).toBe('invalidArguments');
      }
      // Any form is fine for a header the standards do not define, and raw always is.
      const [email] = (
        await h.call('Email/get', {
          ids: [id],
          properties: [
            'header:X-Custom:asDate',
            'header:X-Custom:asAddresses',
            'header:From:asRaw',
          ],
        })
      ).list;
      expect(email['header:X-Custom:asDate']).toBeNull();
      expect(email['header:From:asRaw']).toContain('alice@example.com');
    });

    it('has no second account to copy to or from, unless one is shared', async () => {
      const blobId = await h.upload('bytes');
      const { id } = await h.deliver(inbox);
      const copyEmail = (fromAccountId: string, accountId: string) =>
        h.fail('Email/copy', {
          fromAccountId,
          accountId,
          create: { c: { id, mailboxIds: { [inbox]: true } } },
        });
      const copyBlob = (fromAccountId: string, accountId: string) =>
        h.fail('Blob/copy', { fromAccountId, accountId, blobIds: [blobId] });

      for (const copy of [copyEmail, copyBlob]) {
        expect((await copy(AUTH.accountId, 'acc2')).type).toBe(
          'accountNotFound',
        );
        expect((await copy('acc2', AUTH.accountId)).type).toBe(
          'fromAccountNotFound',
        );
        expect((await copy(AUTH.accountId, AUTH.accountId)).type).toBe(
          'invalidArguments',
        );
      }
      expect((await h.call('Email/query', {})).ids).toEqual([id]);
    });
  });

  describe(`${name}: shared accounts`, () => {
    let h: Harness;
    let inbox: string;
    let teamInbox: string;
    // A user with their own account, a team mailbox, and an archive they may only read.
    const USER = {
      ...AUTH,
      sharedAccounts: {
        team: { name: 'Team mailbox' },
        records: { isReadOnly: true },
      },
    };
    const TEAM = { accountId: 'team', username: 'team@example.com' };
    const RECORDS = { accountId: 'records', username: 'records@example.com' };

    /** Calls as the user, in whichever account each call names. */
    const as = async (
      who: Json,
      calls: Array<[string, Json]>,
    ): Promise<Json[]> =>
      (
        await h.server.handleRequest(
          {
            using: USING,
            methodCalls: calls.map(([method, args], index) => [
              method,
              args,
              `c${index}`,
            ]),
          },
          who,
        )
      ).methodResponses;
    const one = async (accountId: string, method: string, args: Json = {}) => {
      const [response] = await as(USER, [[method, { accountId, ...args }]]);
      expect(response[0], JSON.stringify(response[1])).toBe(method);
      return response[1];
    };
    const mailboxOf = async (accountId: string, role: string) =>
      (await one(accountId, 'Mailbox/query', { filter: { role } })).ids[0];
    const deliverTo = async (who: Json, subject: string) =>
      (
        await h.server.importMessage(
          who,
          encoder.encode(buildMessage({ subject })),
          { mailboxRole: 'inbox' },
        )
      ).id;

    beforeEach(async () => {
      h = await createHarness(factory);
      await h.server.provisionAccount(TEAM);
      await h.server.provisionAccount(RECORDS);
      inbox = await h.mailbox('inbox');
      teamInbox = await mailboxOf('team', 'inbox');
    });

    it('lists the accounts a user may use in their session', () => {
      const session = h.server.getSession(USER);
      expect(session.accounts).toMatchObject({
        [AUTH.accountId]: {
          name: AUTH.username,
          isPersonal: true,
          isReadOnly: false,
        },
        team: { name: 'Team mailbox', isPersonal: false, isReadOnly: false },
        records: { name: 'records', isPersonal: false, isReadOnly: true },
      });
      expect(Object.keys(session.accounts)).toHaveLength(3);
      expect(
        Object.keys(session.accounts['team']?.accountCapabilities ?? {}),
      ).toContain(CAPABILITY_MAIL);
      // The user's own account stays the one used by default.
      expect(session.primaryAccounts[CAPABILITY_MAIL]).toBe(AUTH.accountId);
      // Someone without the shared accounts sees a different session.
      const alone = h.server.getSession(AUTH);
      expect(Object.keys(alone.accounts)).toEqual([AUTH.accountId]);
      expect(alone.state).not.toBe(session.state);
    });

    it('runs each call in the account it names, and keeps accounts apart', async () => {
      const own = await deliverTo(AUTH, 'Mine');
      const shared = await deliverTo(TEAM, 'Ours');

      const responses = await as(USER, [
        ['Email/query', { accountId: AUTH.accountId }],
        ['Email/query', { accountId: 'team' }],
        [
          'Email/get',
          { accountId: 'team', ids: [own, shared], properties: ['subject'] },
        ],
        [
          'Mailbox/set',
          { accountId: 'team', create: { m: { name: 'Projects' } } },
        ],
        ['Email/query', { accountId: 'nobody' }],
      ]);
      expect(responses[0][1].ids).toEqual([own]);
      expect(responses[1][1]).toMatchObject({
        accountId: 'team',
        ids: [shared],
      });
      // An id from the user's own account means nothing in the shared one.
      expect(responses[2][1]).toMatchObject({
        list: [{ id: shared, subject: 'Ours' }],
        notFound: [own],
      });
      expect(responses[3][1].created.m.id).toEqual(expect.any(String));
      expect(responses[4]).toEqual([
        'error',
        { type: 'accountNotFound' },
        'c4',
      ]);
      // The new mailbox is the team's, not the user's.
      expect(
        (await one('team', 'Mailbox/query', { filter: { name: 'Projects' } }))
          .ids,
      ).toHaveLength(1);
      expect(
        (await h.call('Mailbox/query', { filter: { name: 'Projects' } })).ids,
      ).toHaveLength(0);

      // Without the share, the team's account does not exist for this user.
      expect(await as(AUTH, [['Email/query', { accountId: 'team' }]])).toEqual([
        ['error', { type: 'accountNotFound' }, 'c0'],
      ]);
      // And the share goes one way: the team's own user does not get the user's account.
      expect(
        await as(TEAM, [['Email/query', { accountId: AUTH.accountId }]]),
      ).toEqual([['error', { type: 'accountNotFound' }, 'c0']]);
    });

    it('lets a user read an account shared read-only, and change nothing in it', async () => {
      const id = await deliverTo(RECORDS, 'Kept');
      const recordsInbox = await mailboxOf('records', 'inbox');
      expect(
        (
          await one('records', 'Email/get', {
            ids: [id],
            properties: ['subject'],
          })
        ).list[0].subject,
      ).toBe('Kept');
      expect(
        (await one('records', 'Email/query', { filter: { text: 'kept' } })).ids,
      ).toEqual([id]);

      const blobId = await h.upload(buildMessage({ subject: 'New' }));
      const refused = await as(USER, [
        [
          'Email/set',
          {
            accountId: 'records',
            update: { [id]: { 'keywords/$seen': true } },
          },
        ],
        ['Email/set', { accountId: 'records', destroy: [id] }],
        [
          'Mailbox/set',
          { accountId: 'records', create: { m: { name: 'New' } } },
        ],
        [
          'Email/copy',
          {
            fromAccountId: AUTH.accountId,
            accountId: 'records',
            create: { c: { id: 'x', mailboxIds: { [recordsInbox]: true } } },
          },
        ],
        [
          'Blob/copy',
          {
            fromAccountId: AUTH.accountId,
            accountId: 'records',
            blobIds: [blobId],
          },
        ],
        [
          'VacationResponse/set',
          { accountId: 'records', update: { singleton: { isEnabled: true } } },
        ],
      ]);
      // The first two fail per object, which is still a refusal; nothing was changed.
      expect(
        refused.map((response: Json) => response[1].type ?? 'ok'),
      ).not.toContain('ok');
      for (const response of refused) {
        expect(response[1].type, JSON.stringify(response)).toBe(
          'accountReadOnly',
        );
      }
      await expect(
        h.server.upload(USER, 'records', encoder.encode('x'), 'text/plain'),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (
          await one('records', 'Email/get', {
            ids: [id],
            properties: ['keywords'],
          })
        ).list[0].keywords,
      ).toEqual({});
      expect((await one('records', 'Mailbox/query', {})).ids).toHaveLength(6);
    });

    it('copies emails between accounts, and can remove the original', async () => {
      const blob = await h.upload(
        buildMessage({ subject: 'For the team', text: 'Shared knowledge' }),
      );
      const { created: imported } = await h.call('Email/import', {
        emails: {
          m: {
            blobId: blob,
            mailboxIds: { [inbox]: true },
            keywords: { $flagged: true },
            receivedAt: '2026-09-01T08:00:00Z',
          },
        },
      });
      const original = imported.m.id;
      const teamState = (await one('team', 'Email/get', { ids: [] })).state;
      const ownState = (await h.call('Email/get', { ids: [] })).state;

      const copy = await one('team', 'Email/copy', {
        fromAccountId: AUTH.accountId,
        ifInState: teamState,
        ifFromInState: ownState,
        create: {
          kept: { id: original, mailboxIds: { [teamInbox]: true } },
          changed: {
            id: original,
            mailboxIds: { [teamInbox]: true },
            keywords: { $seen: true },
            receivedAt: '2026-10-01T08:00:00Z',
          },
          missing: { id: 'nope', mailboxIds: { [teamInbox]: true } },
          wrongBox: { id: original, mailboxIds: { [inbox]: true } },
          extra: {
            id: original,
            mailboxIds: { [teamInbox]: true },
            subject: 'x',
          },
        },
      });
      expect(copy).toMatchObject({
        fromAccountId: AUTH.accountId,
        accountId: 'team',
        oldState: teamState,
      });
      expect(copy.newState).not.toBe(teamState);
      expect(Object.keys(copy.created).sort()).toEqual(['changed', 'kept']);
      expect(Object.keys(copy.created.kept).sort()).toEqual([
        'blobId',
        'id',
        'size',
        'threadId',
      ]);
      expect(copy.notCreated.missing).toEqual({ type: 'notFound' });
      // A mailbox of the wrong account is not a mailbox of this one.
      expect(copy.notCreated.wrongBox).toMatchObject({
        type: 'invalidProperties',
        properties: ['mailboxIds'],
      });
      expect(copy.notCreated.extra).toMatchObject({
        type: 'invalidProperties',
        properties: ['subject'],
      });

      const { list } = await one('team', 'Email/get', {
        ids: [copy.created.kept.id, copy.created.changed.id],
        properties: [
          'subject',
          'keywords',
          'receivedAt',
          'mailboxIds',
          'preview',
        ],
      });
      // Keywords and the time of arrival come from the original unless given.
      expect(list).toEqual([
        {
          id: copy.created.kept.id,
          subject: 'For the team',
          keywords: { $flagged: true },
          receivedAt: '2026-09-01T08:00:00Z',
          mailboxIds: { [teamInbox]: true },
          preview: 'Shared knowledge',
        },
        {
          id: copy.created.changed.id,
          subject: 'For the team',
          keywords: { $seen: true },
          receivedAt: '2026-10-01T08:00:00Z',
          mailboxIds: { [teamInbox]: true },
          preview: 'Shared knowledge',
        },
      ]);
      // The copy is searchable where it landed, and the original is untouched.
      expect(
        (await one('team', 'Email/query', { filter: { body: 'knowledge' } }))
          .ids,
      ).toHaveLength(2);
      expect((await h.call('Email/query', {})).ids).toEqual([original]);

      // Moving: copy back to the user's own account and destroy where it came from.
      const responses = await as(USER, [
        [
          'Email/copy',
          {
            fromAccountId: 'team',
            accountId: AUTH.accountId,
            create: {
              back: { id: copy.created.kept.id, mailboxIds: { [inbox]: true } },
              gone: { id: 'nope', mailboxIds: { [inbox]: true } },
            },
            onSuccessDestroyOriginal: true,
          },
        ],
        // A later call can refer to what the copy created.
        [
          'Email/get',
          {
            accountId: AUTH.accountId,
            ids: ['#back'],
            properties: ['subject'],
          },
        ],
      ]);
      expect(
        responses.map((response: Json) => [response[0], response[2]]),
      ).toEqual([
        ['Email/copy', 'c0'],
        ['Email/set', 'c0'],
        ['Email/get', 'c1'],
      ]);
      expect(Object.keys(responses[0][1].created)).toEqual(['back']);
      expect(responses[1][1]).toMatchObject({
        accountId: 'team',
        destroyed: [copy.created.kept.id],
      });
      expect((await one('team', 'Email/query', {})).ids).toEqual([
        copy.created.changed.id,
      ]);
      expect((await h.call('Email/query', {})).ids).toHaveLength(2);

      expect(
        (
          await as(USER, [
            [
              'Email/copy',
              {
                fromAccountId: AUTH.accountId,
                accountId: 'team',
                ifInState: teamState,
                create: {},
              },
            ],
          ])
        )[0][1],
      ).toEqual({ type: 'stateMismatch' });
    });

    it('copies blobs between accounts, and serves them from the account they are in', async () => {
      const blobId = await h.upload(buildMessage({ subject: 'Portable' }));
      const result = await one('team', 'Blob/copy', {
        fromAccountId: AUTH.accountId,
        blobIds: [blobId, 'missing'],
      });
      expect(result).toMatchObject({
        fromAccountId: AUTH.accountId,
        accountId: 'team',
        copied: { [blobId]: expect.any(String) },
        notCopied: { missing: { type: 'notFound' } },
      });
      const copy = result.copied[blobId];
      expect(copy).not.toBe(blobId);

      // The copy can be used in the account it was copied to, and only there.
      const imported = await one('team', 'Email/import', {
        emails: { m: { blobId: copy, mailboxIds: { [teamInbox]: true } } },
      });
      expect(imported.created.m.id).toEqual(expect.any(String));
      expect(await h.server.download(USER, 'team', copy)).not.toBeNull();
      expect(await h.server.download(USER, AUTH.accountId, copy)).toBeNull();
      expect(await h.server.download(AUTH, 'team', copy)).toBeNull();

      // Uploading straight into a shared account works the same way.
      const uploaded = await h.server.upload(
        USER,
        'team',
        encoder.encode('for the team'),
        'text/plain',
      );
      expect(uploaded.accountId).toBe('team');
      expect(
        await h.server.download(USER, 'team', uploaded.blobId),
      ).not.toBeNull();
      await expect(
        h.server.upload(AUTH, 'team', encoder.encode('x'), 'text/plain'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe(`${name}: vacation response`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await createHarness(factory);
    });

    const arrive = async (
      lines: string[],
      options: Json = {},
    ): Promise<string | undefined> => {
      const before = h.sent.length;
      await h.server.importMessage(
        AUTH,
        encoder.encode(
          [
            ...lines,
            ...(lines.some((line) => /^message-id:/i.test(line))
              ? []
              : [
                  `Message-ID: <${Math.random().toString(36).slice(2)}@example.org>`,
                ]),
            '',
            'Are you there?',
          ].join('\r\n'),
        ),
        { mailboxRole: 'inbox', delivery: true, ...options },
      );
      expect(h.sent.length - before).toBeLessThanOrEqual(1);
      return h.sent[before]?.message;
    };
    const fromBob = [
      'Return-Path: <bob@example.org>',
      'From: Bob <bob@example.org>',
      'To: Me <me@example.com>',
      'Subject: Lunch?',
    ];
    const enable = (settings: Json = {}) =>
      h.call('VacationResponse/set', {
        update: {
          singleton: {
            isEnabled: true,
            subject: 'Away until Monday',
            textBody: 'Back on Monday.\nUrgent? Call the office.',
            ...settings,
          },
        },
      });

    it('has exactly one settings object, which can only be updated', async () => {
      const initial = await h.call('VacationResponse/get', {});
      expect(initial.list).toEqual([
        {
          id: 'singleton',
          isEnabled: false,
          fromDate: null,
          toDate: null,
          subject: null,
          textBody: null,
          htmlBody: null,
        },
      ]);
      expect(
        await h.call('VacationResponse/get', {
          ids: ['singleton', 'other'],
          properties: ['isEnabled'],
        }),
      ).toMatchObject({
        list: [{ id: 'singleton', isEnabled: false }],
        notFound: ['other'],
      });

      const result = await h.call('VacationResponse/set', {
        ifInState: initial.state,
        create: { n: { isEnabled: true } },
        update: {
          singleton: {
            id: 'singleton',
            isEnabled: true,
            fromDate: '2026-10-10T00:00:00Z',
            htmlBody: '<p>Away</p>',
          },
          other: { isEnabled: true },
        },
        destroy: ['singleton'],
      });
      expect(result.updated).toEqual({ singleton: null });
      expect(result.notCreated.n.type).toBe('singleton');
      expect(result.notDestroyed.singleton.type).toBe('singleton');
      expect(result.notUpdated.other.type).toBe('notFound');
      expect(result.newState).not.toBe(result.oldState);

      const after = await h.call('VacationResponse/get', {});
      expect(after.state).toBe(result.newState);
      expect(after.list[0]).toEqual({
        id: 'singleton',
        isEnabled: true,
        fromDate: '2026-10-10T00:00:00Z',
        toDate: null,
        subject: null,
        textBody: null,
        htmlBody: '<p>Away</p>',
      });

      for (const [property, value] of [
        ['isEnabled', 'yes'],
        ['fromDate', 'tomorrow'],
        ['toDate', '2026-10-10T00:00:00+02:00'],
        ['subject', 'Two\r\nLines'],
        ['textBody', 5],
        ['id', 'another'],
        ['nonsense', true],
      ] as Array<[string, Json]>) {
        const refused = await h.call('VacationResponse/set', {
          update: { singleton: { [property]: value } },
        });
        expect(refused.notUpdated?.singleton, property).toEqual({
          type: 'invalidProperties',
          properties: [property],
        });
      }
      expect(
        (
          await h.fail('VacationResponse/set', {
            ifInState: initial.state,
            update: { singleton: { isEnabled: false } },
          })
        ).type,
      ).toBe('stateMismatch');
    });

    it('answers a person who wrote to the user, once', async () => {
      // Nothing is sent while it is off.
      expect(await arrive(fromBob)).toBeUndefined();

      await enable();
      const reply = (await arrive([
        ...fromBob,
        'Message-ID: <lunch@example.org>',
        'References: <earlier@example.org>',
      ])) as string;
      expect(reply).toContain('From: "Me Myself" <me@example.com>');
      expect(reply).toContain('To: bob@example.org');
      expect(reply).toContain('Subject: Away until Monday');
      expect(reply).toContain('In-Reply-To: <lunch@example.org>');
      expect(reply).toContain(
        'References: <earlier@example.org> <lunch@example.org>',
      );
      // Marks it as automatic, so that nothing answers it in turn.
      expect(reply).toContain('Auto-Submitted: auto-replied');
      expect(reply).toContain('Back on Monday.\r\nUrgent? Call the office.');
      expect(h.sent.at(-1)?.envelope).toEqual({
        mailFrom: 'me@example.com',
        rcptTo: ['bob@example.org'],
        tags: { account: AUTH.accountId },
      });

      // The same person is not answered again, however they spell their address.
      expect(await arrive(fromBob)).toBeUndefined();
      expect(
        await arrive([
          'Return-Path: <BOB@Example.org>',
          'From: Bob <bob@example.org>',
          'To: me@example.com',
          'Subject: Hello?',
        ]),
      ).toBeUndefined();
      // Someone else is.
      expect(
        await arrive([
          'Return-Path: <carol@example.org>',
          'From: Carol <carol@example.org>',
          'Cc: me@example.com',
          'Subject: FYI',
        ]),
      ).toContain('To: carol@example.org');

      // A changed response is news to everyone, so they hear it once more.
      await enable({
        subject: 'Away until Tuesday',
        htmlBody: '<p>Back <b>Tuesday</b></p>',
        textBody: null,
      });
      const second = (await arrive(fromBob)) as string;
      expect(second).toContain('Subject: Away until Tuesday');
      expect(second).toContain('multipart/alternative');
      expect(second).toContain('Back Tuesday');
      expect(second).toContain('<p>Back <b>Tuesday</b></p>');
      expect(await arrive(fromBob)).toBeUndefined();

      // The replies are not kept as mail of the account, and the mail itself arrived.
      expect((await h.call('Email/query', {})).ids).toHaveLength(7);
      expect((await h.call('EmailSubmission/query', {})).ids).toHaveLength(0);
    });

    it('makes up a subject and a body when none are set', async () => {
      await enable({ subject: null, textBody: null });
      const reply = (await arrive(fromBob)) as string;
      expect(reply).toContain('Subject: Auto: Lunch?');
      expect(reply).toContain('This is an automatic reply.');
    });

    it('answers only between its dates', async () => {
      await enable({
        fromDate: '2099-01-01T00:00:00Z',
        toDate: '2099-02-01T00:00:00Z',
      });
      expect(await arrive(fromBob)).toBeUndefined();
      await enable({
        fromDate: '2020-01-01T00:00:00Z',
        toDate: '2020-02-01T00:00:00Z',
      });
      expect(await arrive(fromBob)).toBeUndefined();
      await enable({
        fromDate: '2020-01-01T00:00:00Z',
        toDate: '2099-02-01T00:00:00Z',
      });
      expect(await arrive(fromBob)).toContain('To: bob@example.org');
    });

    it('never answers lists, bounces, robots, junk or mail not addressed to the user', async () => {
      await enable();
      const silent: Array<[string, string[], Json?]> = [
        [
          'a bounce',
          [
            'Return-Path: <>',
            'From: Mail Delivery <mailer-daemon@example.org>',
            'To: me@example.com',
            'Subject: Undelivered',
          ],
        ],
        [
          'an automatic message',
          [...fromBob, 'Auto-Submitted: auto-generated'],
        ],
        [
          'another vacation reply',
          [...fromBob, 'Auto-Submitted: auto-replied (vacation)'],
        ],
        ['a list, by List-Id', [...fromBob, 'List-Id: <announce.example.org>']],
        [
          'a list, by List-Unsubscribe',
          [...fromBob, 'List-Unsubscribe: <mailto:leave@example.org>'],
        ],
        ['bulk mail', [...fromBob, 'Precedence: bulk']],
        [
          'mail asking not to be answered',
          [...fromBob, 'X-Auto-Response-Suppress: OOF, AutoReply'],
        ],
        [
          'a no-reply sender',
          [
            'Return-Path: <no-reply@shop.example>',
            'From: Shop <no-reply@shop.example>',
            'To: me@example.com',
            'Subject: Receipt',
          ],
        ],
        [
          'a bounce address',
          [
            'Return-Path: <news-bounces+123@lists.example>',
            'From: News <news@lists.example>',
            'To: me@example.com',
            'Subject: News',
          ],
        ],
        [
          'a blind copy',
          [
            'Return-Path: <dan@example.org>',
            'From: Dan <dan@example.org>',
            'To: someone-else@example.org',
            'Subject: Hidden',
          ],
        ],
        [
          "mail to an address that is not the user's",
          [
            'Return-Path: <dan@example.org>',
            'From: Dan <dan@example.org>',
            'To: other@example.com',
            'Subject: Wrong person',
          ],
        ],
        [
          "the user's own mail",
          [
            'Return-Path: <me@example.com>',
            'From: Me <me@example.com>',
            'To: me@example.com',
            'Subject: Note to self',
          ],
        ],
        [
          'junk',
          [
            'Return-Path: <eve@example.org>',
            'From: Eve <eve@example.org>',
            'To: me@example.com',
            'Subject: You won',
          ],
          { keywords: { $junk: true } },
        ],
        [
          'a client upload',
          [
            'Return-Path: <frank@example.org>',
            'From: Frank <frank@example.org>',
            'To: me@example.com',
            'Subject: Imported',
          ],
          { delivery: false },
        ],
      ];
      for (const [label, lines, options] of silent) {
        expect(await arrive(lines, options), label).toBeUndefined();
      }
      // "Auto-Submitted: no" says a person sent it.
      expect(
        await arrive([
          'Return-Path: <grace@example.org>',
          'From: Grace <grace@example.org>',
          'To: me@example.com',
          'Subject: Hi',
          'Auto-Submitted: no',
        ]),
      ).toContain('To: grace@example.org');
      // The reply goes to the envelope sender, not to whatever From claims.
      expect(
        await arrive([
          'Return-Path: <real-sender@example.org>',
          'From: Someone Else <victim@example.net>',
          'To: me@example.com',
          'Subject: Hi',
        ]),
      ).toContain('To: real-sender@example.org');
      // An address the catch-all identity covers counts as the user's, and is what the reply comes from.
      const viaAlias = (await arrive([
        'Return-Path: <henry@example.org>',
        'From: Henry <henry@example.org>',
        'To: sales@catch.example.com',
        'Subject: Quote',
      ])) as string;
      expect(viaAlias).toContain('From: sales@catch.example.com');
    });

    it('delivers the mail even when the reply cannot be sent', async () => {
      const outcomes: Array<[string, boolean]> = [];
      const server = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        transport: {
          async send() {
            throw new MailRejectedError('Email address is not verified');
          },
        },
        identities: () => [{ id: 'me', email: 'me@example.com' }],
        onAutoReply: (outcome, error) =>
          outcomes.push([outcome, error !== undefined]),
      });
      await enable();
      const raw = (subject: string, extra: string[] = []) =>
        encoder.encode(
          [
            ...fromBob.slice(0, 3),
            `Subject: ${subject}`,
            ...extra,
            '',
            'x',
          ].join('\r\n'),
        );
      const { id } = await server.importMessage(AUTH, raw('One'), {
        mailboxRole: 'inbox',
        delivery: true,
      });
      expect((await h.call('Email/get', { ids: [id] })).list).toHaveLength(1);
      await server.importMessage(AUTH, raw('Two', ['List-Id: <l.example>']), {
        mailboxRole: 'inbox',
        delivery: true,
      });
      expect(outcomes).toEqual([
        ['failed', true],
        ['mailing-list', false],
      ]);
    });

    it('is not offered by a server that cannot send', async () => {
      const server = createJmapServer({ storage: h.adapter, urls: URLS });
      expect(Object.keys(server.getSession(AUTH).capabilities)).not.toContain(
        CAPABILITY_VACATION,
      );
      await enable();
      // Mail arrives as usual; there is simply nothing to answer with.
      await server.importMessage(
        AUTH,
        encoder.encode([...fromBob, '', 'x'].join('\r\n')),
        {
          mailboxRole: 'inbox',
          delivery: true,
        },
      );
      expect(h.sent).toHaveLength(0);
    });
  });

  describe(`${name}: sending later`, () => {
    let h: Harness;
    let server: JmapServer;
    let drafts: string;
    let sentBox: string;
    /** What the scheduler was asked to do, in order. */
    let scheduled: Array<{ submissionId: string; sendAt: Date }>;
    let cancelled: string[];
    /** Makes the transport fail the next send with this error. */
    let failNext: Error | undefined;
    let sent: Array<{ message: string; envelope: MailEnvelope }>;

    beforeEach(async () => {
      h = await createHarness(factory);
      drafts = await h.mailbox('drafts');
      sentBox = await h.mailbox('sent');
      scheduled = [];
      cancelled = [];
      failNext = undefined;
      sent = [];
      server = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        maxDelayedSend: 3600,
        transport: {
          async send(message, envelope) {
            if (failNext) {
              const error = failNext;
              failNext = undefined;
              throw error;
            }
            sent.push({ message: decoder.decode(message), envelope });
            return { messageIds: [`relay-${sent.length}@relay.example`] };
          },
        },
        scheduler: {
          async schedule(job) {
            scheduled.push({
              submissionId: job.submissionId,
              sendAt: job.sendAt,
            });
          },
          async cancel(job) {
            cancelled.push(job.submissionId);
          },
        },
        identities: () => [{ id: 'me', email: 'me@example.com', name: 'Me' }],
      });
    });

    const call = async (method: string, args: Json = {}): Promise<Json> => {
      const response = await server.handleRequest(
        {
          using: USING,
          methodCalls: [[method, { accountId: AUTH.accountId, ...args }, 'c']],
        },
        AUTH,
      );
      return response.methodResponses;
    };
    const one = async (method: string, args: Json = {}) =>
      (await call(method, args))[0][1];
    const draft = async (subject = 'Later') =>
      (
        await one('Email/set', {
          create: {
            d: {
              mailboxIds: { [drafts]: true },
              keywords: { $draft: true },
              from: [{ email: 'me@example.com' }],
              to: [{ email: 'bob@example.org' }],
              bcc: [{ email: 'hidden@example.org' }],
              subject,
              bodyValues: { b: { value: 'As planned.' } },
              textBody: [{ partId: 'b' }],
            },
          },
        })
      ).created.d.id;
    const hold = async (
      parameters: Json,
      emailId?: string,
      extra: Json = {},
    ) => {
      const id = emailId ?? (await draft());
      const result = await one('EmailSubmission/set', {
        create: {
          s: {
            identityId: 'me',
            emailId: id,
            envelope: {
              mailFrom: { email: 'me@example.com', parameters },
              rcptTo: [
                { email: 'bob@example.org' },
                { email: 'hidden@example.org' },
              ],
            },
          },
        },
        ...extra,
      });
      return { emailId: id, result, submission: result.created?.s };
    };
    const read = async (id: string) =>
      (await one('EmailSubmission/get', { ids: [id] })).list[0];

    it('says in the session how long a message may be held', () => {
      const capability = server.getSession(AUTH).capabilities[
        CAPABILITY_SUBMISSION
      ] as Json;
      expect(capability).toEqual({
        maxDelayedSend: 3600,
        submissionExtensions: { FUTURERELEASE: ['3600'] },
      });
      // A server with nothing to wake it up offers no delay.
      expect(
        h.server.getSession(AUTH).capabilities[CAPABILITY_SUBMISSION],
      ).toEqual({ maxDelayedSend: 0, submissionExtensions: {} });
    });

    it('holds a message, then sends it when its time comes', async () => {
      const before = Date.now();
      const { emailId, submission } = await hold({ HOLDFOR: '600' });
      expect(submission).toMatchObject({
        undoStatus: 'pending',
        deliveryStatus: {
          'bob@example.org': { delivered: 'queued', displayed: 'unknown' },
        },
      });
      const sendAt = Date.parse(submission.sendAt);
      expect(sendAt).toBeGreaterThanOrEqual(before + 599_000);
      expect(sendAt).toBeLessThanOrEqual(Date.now() + 600_000);
      // Nothing has gone out, and something will wake up at the right time.
      expect(sent).toHaveLength(0);
      expect(scheduled).toEqual([
        { submissionId: submission.id, sendAt: new Date(submission.sendAt) },
      ]);
      const stored = await read(submission.id);
      expect(stored).toMatchObject({
        undoStatus: 'pending',
        sendAt: submission.sendAt,
        envelope: {
          mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '600' } },
        },
      });
      // How the message is kept meanwhile is the server's business.
      expect(stored).not.toHaveProperty('held');
      expect(
        (
          await one('EmailSubmission/query', {
            filter: { undoStatus: 'pending' },
          })
        ).ids,
      ).toEqual([submission.id]);

      // The draft is changed and then destroyed; what was submitted still goes out.
      await one('Email/set', { destroy: [emailId] });
      expect(await server.sendScheduled(AUTH, submission.id)).toBe('sent');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.envelope).toEqual({
        mailFrom: 'me@example.com',
        rcptTo: ['bob@example.org', 'hidden@example.org'],
        tags: { account: AUTH.accountId, submission: submission.id },
      });
      expect(sent[0]?.message).toContain('Subject: Later');
      expect(sent[0]?.message).toContain('As planned.');
      expect(sent[0]?.message).not.toMatch(/^bcc:/im);

      const after = await read(submission.id);
      expect(after.undoStatus).toBe('final');
      expect(after.deliveryStatus['bob@example.org']).toMatchObject({
        delivered: 'queued',
        smtpReply: '250 Accepted',
      });
      // A second wake-up, as schedulers that promise "at least once" produce, sends nothing more.
      expect(await server.sendScheduled(AUTH, submission.id)).toBe(
        'not-pending',
      );
      expect(sent).toHaveLength(1);
      // Delivery reports find it like any other.
      expect(
        await server.recordDelivery(AUTH, submission.id, {
          'bob@example.org': { delivered: 'yes', smtpReply: '250 OK' },
        }),
      ).toBe(true);
      expect(
        (await read(submission.id)).deliveryStatus['bob@example.org'].delivered,
      ).toBe('yes');
      // Nothing is left behind once it has gone.
      expect(
        await h.server.download(AUTH, AUTH.accountId, 'missing'),
      ).toBeNull();
    });

    it('can be cancelled until it is sent, and not after', async () => {
      const { emailId, submission } = await hold({
        holduntil: new Date(Date.now() + 900_000).toISOString(),
      });
      expect(submission.undoStatus).toBe('pending');

      // Cancelling moves the message back to drafts in the same call.
      await one('Email/set', {
        update: {
          [emailId]: {
            mailboxIds: { [sentBox]: true },
            'keywords/$draft': null,
          },
        },
      });
      const responses = await call('EmailSubmission/set', {
        update: { [submission.id]: { undoStatus: 'canceled' } },
        onSuccessUpdateEmail: {
          [submission.id]: {
            mailboxIds: { [drafts]: true },
            'keywords/$draft': true,
          },
        },
      });
      expect(responses.map((response: Json) => response[0])).toEqual([
        'EmailSubmission/set',
        'Email/set',
      ]);
      expect(responses[0][1].updated).toEqual({ [submission.id]: null });
      expect(responses[1][1].updated).toEqual({ [emailId]: null });
      expect(
        (
          await one('Email/get', {
            ids: [emailId],
            properties: ['mailboxIds', 'keywords'],
          })
        ).list[0],
      ).toMatchObject({
        mailboxIds: { [drafts]: true },
        keywords: { $draft: true },
      });

      expect(cancelled).toEqual([submission.id]);
      const stored = await read(submission.id);
      expect(stored.undoStatus).toBe('canceled');
      expect(stored.deliveryStatus['bob@example.org'].delivered).toBe('no');
      // The wake-up may still come; it finds nothing to send.
      expect(await server.sendScheduled(AUTH, submission.id)).toBe(
        'not-pending',
      );
      expect(sent).toHaveLength(0);
      // Cancelling again changes nothing and is not an error.
      expect(
        (
          await one('EmailSubmission/set', {
            update: { [submission.id]: { undoStatus: 'canceled' } },
          })
        ).updated,
      ).toEqual({ [submission.id]: null });
      // A cancelled submission is only a record now, and can be removed.
      expect(
        (await one('EmailSubmission/set', { destroy: [submission.id] }))
          .destroyed,
      ).toEqual([submission.id]);

      const second = await hold({ HOLDFOR: '60' });
      await server.sendScheduled(AUTH, second.submission.id);
      const late = await one('EmailSubmission/set', {
        update: {
          [second.submission.id]: { undoStatus: 'canceled' },
          missing: { undoStatus: 'canceled' },
        },
      });
      expect(late.notUpdated[second.submission.id].type).toBe('cannotUnsend');
      expect(late.notUpdated.missing.type).toBe('notFound');
      for (const [patch, properties] of [
        [{ undoStatus: 'pending' }, ['undoStatus']],
        [{ sendAt: '2030-01-01T00:00:00Z' }, ['sendAt']],
        [{ undoStatus: 'canceled', identityId: 'x' }, ['identityId']],
      ] as Array<[Json, string[]]>) {
        expect(
          (
            await one('EmailSubmission/set', {
              update: { [second.submission.id]: patch },
            })
          ).notUpdated[second.submission.id],
        ).toMatchObject({ type: 'invalidProperties', properties });
      }
    });

    it('lets exactly one of a cancellation and a send win', async () => {
      for (let round = 0; round < 5; round++) {
        const { submission } = await hold({ HOLDFOR: '60' });
        const [cancel, outcome] = await Promise.all([
          one('EmailSubmission/set', {
            update: { [submission.id]: { undoStatus: 'canceled' } },
          }),
          server.sendScheduled(AUTH, submission.id),
        ]);
        const wasCancelled = cancel.updated !== null;
        const wasSent = outcome === 'sent';
        expect(wasCancelled, `round ${round}: ${outcome}`).not.toBe(wasSent);
        expect((await read(submission.id)).undoStatus).toBe(
          wasSent ? 'final' : 'canceled',
        );
      }
      // Several wake-ups at once send one message.
      const { submission } = await hold({ HOLDFOR: '60' });
      sent.length = 0;
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () =>
          server.sendScheduled(AUTH, submission.id),
        ),
      );
      expect(outcomes.filter((outcome) => outcome === 'sent')).toHaveLength(1);
      expect(sent).toHaveLength(1);
    });

    it('keeps a waiting message from being forgotten', async () => {
      const { submission } = await hold({ HOLDFOR: '60' });
      const refused = await one('EmailSubmission/set', {
        destroy: [submission.id],
      });
      expect(refused.notDestroyed[submission.id].type).toBe('forbidden');
      expect(await server.sendScheduled(AUTH, submission.id)).toBe('sent');
      expect(
        (await one('EmailSubmission/set', { destroy: [submission.id] }))
          .destroyed,
      ).toEqual([submission.id]);
      expect(await server.sendScheduled(AUTH, 'es-missing')).toBe('not-found');
    });

    it('records a refusal, and tries again after a failure on the way', async () => {
      const refusedOne = await hold({ HOLDFOR: '60' });
      failNext = new MailRejectedError('Recipient is on the suppression list');
      expect(await server.sendScheduled(AUTH, refusedOne.submission.id)).toBe(
        'rejected',
      );
      const status = (await read(refusedOne.submission.id)).deliveryStatus[
        'bob@example.org'
      ];
      expect(status).toEqual({
        delivered: 'no',
        displayed: 'unknown',
        smtpReply: '550 5.0.0 Recipient is on the suppression list',
      });
      // It is over: another wake-up does not try again.
      expect(await server.sendScheduled(AUTH, refusedOne.submission.id)).toBe(
        'not-pending',
      );

      const retried = await hold({ HOLDFOR: '60' });
      failNext = new Error('connection reset');
      await expect(
        server.sendScheduled(AUTH, retried.submission.id),
      ).rejects.toThrow('connection reset');
      // It can no longer be cancelled, since nobody knows how far the attempt got...
      expect(
        (
          await one('EmailSubmission/set', {
            update: { [retried.submission.id]: { undoStatus: 'canceled' } },
          })
        ).notUpdated[retried.submission.id].type,
      ).toBe('cannotUnsend');
      // ...and the next wake-up sends it.
      sent.length = 0;
      expect(await server.sendScheduled(AUTH, retried.submission.id)).toBe(
        'sent',
      );
      expect(sent).toHaveLength(1);
    });

    it('checks the delay asked for, and who is sending, before holding anything', async () => {
      for (const parameters of [
        { HOLDFOR: '3601' },
        { HOLDFOR: 'soon' },
        { HOLDFOR: null },
        { HOLDUNTIL: 'tomorrow' },
        { HOLDUNTIL: new Date(Date.now() + 7_200_000).toISOString() },
        {
          HOLDFOR: '60',
          HOLDUNTIL: new Date(Date.now() + 60_000).toISOString(),
        },
      ]) {
        const { result } = await hold(parameters);
        expect(result.notCreated?.s, JSON.stringify(parameters)).toMatchObject({
          type: 'invalidProperties',
          properties: ['envelope'],
        });
      }
      expect(scheduled).toHaveLength(0);
      expect(sent).toHaveLength(0);

      // No delay worth holding for: it simply goes.
      for (const parameters of [
        { HOLDFOR: '0' },
        { HOLDUNTIL: '2020-01-01T00:00:00Z' },
        { OTHER: 'x' },
      ]) {
        const { submission } = await hold(parameters);
        expect(submission.undoStatus, JSON.stringify(parameters)).toBe('final');
      }
      expect(sent).toHaveLength(3);
      expect(scheduled).toHaveLength(0);

      // The sender is checked when the message is submitted, not when it leaves.
      const other = await one('Email/set', {
        create: {
          d: {
            mailboxIds: { [drafts]: true },
            from: [{ email: 'boss@example.com' }],
            to: [{ email: 'bob@example.org' }],
            subject: 'Not mine',
            bodyValues: { b: { value: 'x' } },
            textBody: [{ partId: 'b' }],
          },
        },
      });
      const { result } = await hold({ HOLDFOR: '60' }, other.created.d.id);
      expect(result.notCreated.s.type).toBe('forbiddenFrom');

      // A server that cannot hold says so instead of sending at once.
      const refused = await h.call('EmailSubmission/set', {
        create: {
          s: {
            identityId: 'me',
            emailId: await draft(),
            envelope: {
              mailFrom: {
                email: 'me@example.com',
                parameters: { HOLDFOR: '60' },
              },
              rcptTo: [{ email: 'bob@example.org' }],
            },
          },
        },
      });
      expect(refused.notCreated.s).toMatchObject({
        type: 'invalidProperties',
        properties: ['envelope'],
      });
      expect(h.sent).toHaveLength(0);
    });

    it('does not hold a message it could not arrange to send', async () => {
      const failing = createJmapServer({
        storage: h.adapter,
        urls: URLS,
        transport: { send: async () => undefined },
        scheduler: {
          schedule: async () => {
            throw new Error('scheduler unavailable');
          },
        },
        identities: () => [{ id: 'me', email: 'me@example.com' }],
      });
      const emailId = await draft();
      const response = await failing.handleRequest(
        {
          using: USING,
          methodCalls: [
            [
              'EmailSubmission/set',
              {
                accountId: AUTH.accountId,
                create: {
                  s: {
                    identityId: 'me',
                    emailId,
                    envelope: {
                      mailFrom: {
                        email: 'me@example.com',
                        parameters: { HOLDFOR: '60' },
                      },
                      rcptTo: [{ email: 'bob@example.org' }],
                    },
                  },
                },
              },
              'c',
            ],
          ],
        },
        AUTH,
      );
      expect(response.methodResponses[0]?.[1]).toEqual({ type: 'serverFail' });
      // Nothing is left looking as if it were waiting.
      expect((await one('EmailSubmission/query', {})).ids).toEqual([]);
    });
  });
}
