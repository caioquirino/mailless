import { CAPABILITY_CORE, CAPABILITY_MAIL } from '@mailless/jmap-core';
import { createJmapServer } from '@mailless/jmap-server';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';
import { buildMessage } from '@mailless/jmap-server/testing';
import {
  capabilitiesFor,
  createJmapClient,
  JmapMethodError,
  JmapRequestError,
} from '../index.js';

const BASE = 'https://mail.example.com';
const AUTH = { accountId: 'ann', username: 'ann' };

/** A real server, reached through its HTTP handler without a network. */
async function setup(options: { sharedAccounts?: Record<string, never> } = {}) {
  const server = createJmapServer({
    storage: new InMemoryStorageAdapter(),
    urls: jmapUrls(BASE),
  });
  await server.provisionAccount(AUTH);
  const requests: Request[] = [];
  const handler = createFetchHandler({
    server,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer good'
        ? { ...AUTH, ...options }
        : null,
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handler(request);
  };
  const client = createJmapClient({
    sessionUrl: `${BASE}/.well-known/jmap`,
    authorization: 'Bearer good',
    fetch,
  });
  const paths = () => requests.map((request) => new URL(request.url).pathname);
  return { server, client, fetch, requests, paths };
}

describe('createJmapClient', () => {
  it('reads the session once, and knows the user’s account from it', async () => {
    const { client, paths } = await setup();
    const session = await client.session();
    expect(session.username).toBe('ann');
    expect(session.apiUrl).toBe(`${BASE}/jmap/api`);
    expect(await client.accountId()).toBe('ann');
    await client.session();
    expect(paths()).toEqual(['/.well-known/jmap']);

    await client.session({ refresh: true });
    expect(paths()).toHaveLength(2);
    await expect(client.accountId('urn:example:nothing')).rejects.toThrow(
      /no primary account/,
    );
  });

  it('makes one call, for the user’s own account unless another is named', async () => {
    const { client, requests } = await setup();
    const mailboxes = await client.call('Mailbox/get', { ids: null });
    expect(mailboxes.accountId).toBe('ann');
    expect(mailboxes.list.map((mailbox) => mailbox.role)).toContain('inbox');

    const sent = (await requests.at(-1)?.json()) as {
      using: string[];
      methodCalls: unknown[];
    };
    expect(sent.using).toEqual([CAPABILITY_CORE, CAPABILITY_MAIL]);
    expect(sent.methodCalls).toEqual([
      ['Mailbox/get', { accountId: 'ann', ids: null }, 'c0'],
    ]);
  });

  it('sends several calls as one request, each able to use what an earlier one found', async () => {
    const { client, server, requests } = await setup();
    const inbox = (
      await client.call('Mailbox/query', { filter: { role: 'inbox' } })
    ).ids[0] as string;
    for (const subject of ['First', 'Second']) {
      await server.importMessage(
        AUTH,
        new TextEncoder().encode(buildMessage({ subject, text: 'Hello' })),
        { mailboxRole: 'inbox' },
      );
    }
    const before = requests.length;

    const batch = client.batch();
    const query = batch.call('Email/query', {
      filter: { inMailbox: inbox },
      sort: [{ property: 'subject' }],
    });
    const emails = batch.call('Email/get', {
      '#ids': query.ref('/ids'),
      properties: ['subject', 'threadId'],
    });
    const threads = batch.call('Thread/get', {
      '#ids': emails.ref('/list/*/threadId'),
    });
    const result = await batch.send();

    expect(requests.length - before).toBe(1);
    expect(result.get(query).ids).toHaveLength(2);
    expect(result.get(emails).list.map((email) => email.subject)).toEqual([
      'First',
      'Second',
    ]);
    expect(result.get(threads).list).toHaveLength(2);
    expect(result.ok(emails)).toBe(true);
  });

  it('changes things, and says what the server made of each', async () => {
    const { client } = await setup();
    const batch = client.batch();
    const created = batch.call('Mailbox/set', {
      create: { projects: { name: 'Projects' } },
    });
    const listed = batch.call('Mailbox/query', {
      filter: { name: 'Projects' },
    });
    const result = await batch.send();

    const id = result.get(created).created?.['projects']?.id;
    expect(id).toEqual(expect.any(String));
    expect(result.get(listed).ids).toEqual([id]);

    const refused = await client.call('Mailbox/set', {
      create: { again: { name: 'Projects' } },
    });
    expect(refused.notCreated?.['again']?.type).toBe('invalidProperties');
  });

  it('fails one call without failing the batch', async () => {
    const { client } = await setup();
    const batch = client.batch();
    const bad = batch.call('Email/get', { accountId: 'someone-else', ids: [] });
    const good = batch.call('Mailbox/get', { ids: [] });
    const result = await batch.send();

    expect(result.get(good).list).toEqual([]);
    expect(result.ok(bad)).toBe(false);
    expect(() => result.get(bad)).toThrow(JmapMethodError);
    try {
      result.get(bad);
    } catch (error) {
      expect(error).toMatchObject({
        method: 'Email/get',
        type: 'accountNotFound',
      });
    }
    await expect(
      client.call('Email/get', { accountId: 'someone-else', ids: [] }),
    ).rejects.toMatchObject({ type: 'accountNotFound' });
  });

  it('calls methods it has no types for, when told which capability they use', async () => {
    const { client } = await setup();
    expect(await client.call('Core/echo', { hello: 'there' })).toEqual({
      hello: 'there',
    });

    expect(() => capabilitiesFor(['Calendar/get'])).toThrow(/using/);
    await expect(client.call('Calendar/get', {})).rejects.toThrow(/using/);
    // Named, the server is asked, and says it does not have it.
    await expect(
      client.call(
        'Calendar/get',
        {},
        { using: [CAPABILITY_CORE, 'urn:ietf:params:jmap:calendars'] },
      ),
    ).rejects.toMatchObject({
      name: 'JmapRequestError',
      type: 'urn:ietf:params:jmap:error:unknownCapability',
    });
  });

  it('uploads content and downloads it again', async () => {
    const { client, paths } = await setup();
    const data = new TextEncoder().encode('an attachment');
    const blob = await client.upload(data, { type: 'text/plain' });
    expect(blob).toMatchObject({
      accountId: 'ann',
      type: 'text/plain',
      size: data.length,
    });
    expect(
      await client.download(blob.blobId, {
        name: 'note with spaces.txt',
        type: 'text/plain',
      }),
    ).toEqual(data);
    expect(paths().at(-1)).toBe(
      `/jmap/download/ann/${blob.blobId}/note%20with%20spaces.txt`,
    );
    await expect(client.download('nothing-here')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('says so when the sign-in is refused, and asks for the header each time', async () => {
    const { fetch } = await setup();
    const tokens = ['Bearer expired', 'Bearer good', 'Bearer good'];
    let asked = 0;
    const client = createJmapClient({
      sessionUrl: `${BASE}/.well-known/jmap`,
      authorization: async () => tokens[asked++] as string,
      fetch,
    });
    const refused = await client.session().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(JmapRequestError);
    expect(refused).toMatchObject({ status: 401 });

    // Nothing of the failure is kept: with a good token, it works.
    expect((await client.session()).username).toBe('ann');
    await client.call('Core/echo', {});
    expect(asked).toBe(3);
  });

  it('reads the session again once the server says it changed', async () => {
    const { client, fetch, paths } = await setup();
    await client.session();
    await client.call('Core/echo', {});
    expect(paths().filter((path) => path === '/.well-known/jmap')).toHaveLength(
      1,
    );

    // Another client of the same user, seen by a server that now shares an account with them.
    const changed = await setup({ sharedAccounts: {} });
    void fetch;
    const stale = createJmapClient({
      sessionUrl: `${BASE}/.well-known/jmap`,
      authorization: 'Bearer good',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const response = await changed.fetch(request);
        if (new URL(request.url).pathname !== '/jmap/api') return response;
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, sessionState: 'something-else' });
      },
    });
    await stale.session();
    await stale.call('Core/echo', {});
    await stale.session();
    expect(
      changed.paths().filter((path) => path === '/.well-known/jmap'),
    ).toHaveLength(2);
  });

  it('refuses to send nothing', async () => {
    const { client } = await setup();
    await expect(client.batch().send()).rejects.toThrow(/no calls/);
  });
});
