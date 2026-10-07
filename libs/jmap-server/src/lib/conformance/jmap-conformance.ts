import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  CAPABILITY_SUBMISSION,
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
const USING = [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION];
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
      expect(page.canCalculateChanges).toBe(false);

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
        sentAt: '2026-10-06T12:00:00Z',
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
      expect(email['header:Date:asDate']).toBe('2026-10-06T12:00:00Z');
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
      expect(result.notCreated.noBlob).toEqual({
        type: 'blobNotFound',
        notFound: ['missing'],
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

    it('reads the same body text whether or not the message is multipart', async () => {
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
        expect(email.textBody[0].size).toBe(15);
        bodies.push(email.bodyValues[email.textBody[0].partId].value);
      }
      expect(bodies).toEqual([
        'Just this line.',
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
        expect(page.queryState).toBe(
          (await h.call('Email/get', { ids: [] })).state,
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
      ).toEqual(['bodyValues']);
      expect(
        (await refusal({ textBody: [{ partId: 'body', type: 'text/html' }] }))
          .properties,
      ).toEqual(['textBody']);
      expect(
        (await refusal({ textBody: [{ partId: 'body' }, { partId: 'body' }] }))
          .properties,
      ).toEqual(['textBody']);
      expect(
        (await refusal({ textBody: [{ type: 'text/plain' }] })).properties,
      ).toEqual(['textBody']);
      expect(
        (
          await refusal({
            bodyStructure: { partId: 'body', type: 'text/plain' },
          })
        ).properties,
      ).toEqual(['bodyStructure']);
      expect(
        (
          await refusal({
            bodyValues: { body: { value: 'x', isTruncated: true } },
          })
        ).properties,
      ).toEqual(['bodyValues']);
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
      for (const header of [
        'header:Bcc',
        'header:From',
        'header:Content-Type',
        'header:Date',
      ]) {
        expect((await refusal({ [header]: 'x' })).properties, header).toEqual([
          header,
        ]);
      }
      expect(
        (await refusal({ 'header:X-Note:asAddresses': 'x' })).properties,
      ).toEqual(['header:X-Note:asAddresses']);
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
      expect(wire).toContain('To: Bob <bob@example.org>');
      expect(wire).toContain('Cc: carol@example.org');
      expect(wire.toLowerCase()).not.toContain('bcc');
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

    it('answers EmailSubmission/queryChanges, without calculating', async () => {
      const { queryState } = await h.call('EmailSubmission/query', {});
      expect(
        (
          await h.fail('EmailSubmission/queryChanges', {
            sinceQueryState: queryState,
          })
        ).type,
      ).toBe('cannotCalculateChanges');
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
}
