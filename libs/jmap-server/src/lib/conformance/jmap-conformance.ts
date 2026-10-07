import {
  CAPABILITY_CORE,
  CAPABILITY_MAIL,
  REQUEST_ERROR,
  RequestError,
  type Invocation,
} from '@mailless/jmap-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createJmapServer, type JmapServer } from '../server.js';
import type { StorageAdapter } from '../storage.js';
import type { StorageAdapterFactory } from './storage-contract.js';

// Responses are untyped JSON; the tests assert on their shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const AUTH = { accountId: 'acc1', username: 'user@example.com' };
const USING = [CAPABILITY_CORE, CAPABILITY_MAIL];
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
  if (htmlPart) {
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
  const server = createJmapServer({ storage: adapter, urls: URLS });
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
      expect(result.notCreated.n.type).toBe('forbidden');
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
          (await h.fail('Email/query', { filter: { text: 'budget' } })).type,
        ).toBe('unsupportedFilter');
        expect(
          (await h.fail('Email/query', { filter: { body: 'budget' } })).type,
        ).toBe('unsupportedFilter');
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
              using: USING,
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
}
