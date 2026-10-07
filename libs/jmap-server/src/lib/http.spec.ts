import { CAPABILITY_CORE, CAPABILITY_MAIL } from '@mailless/jmap-core';
import { buildMessage } from './conformance/jmap-conformance.js';
import { createFetchHandler, jmapUrls } from './http.js';
import { InMemoryStorageAdapter } from './memory-adapter.js';
import { createJmapServer } from './server.js';

const BASE = 'https://mail.example.com';
const AUTH = { accountId: 'acc1', username: 'me' };
const USING = [CAPABILITY_CORE, CAPABILITY_MAIL];

// Response bodies are untyped JSON; the tests assert on their shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (response: Response): Promise<any> => response.json();

function setup(limits = {}) {
  const errors: unknown[] = [];
  const server = createJmapServer({
    storage: new InMemoryStorageAdapter(),
    urls: jmapUrls(`${BASE}/`),
    limits,
  });
  const handle = createFetchHandler({
    server,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer good' ? AUTH : null,
    challenge: 'Basic realm="test", Bearer',
    onError: (error) => errors.push(error),
  });
  const call = (path: string, init: RequestInit = {}) =>
    handle(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: { authorization: 'Bearer good', ...(init.headers as object) },
      }),
    );
  const api = (methodCalls: unknown[]) =>
    call('/jmap/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ using: USING, methodCalls }),
    });
  return { server, handle, call, api, errors };
}

describe('createFetchHandler', () => {
  it('builds URLs that match its routes', () => {
    expect(jmapUrls('https://x.test/')).toEqual({
      api: 'https://x.test/jmap/api',
      download:
        'https://x.test/jmap/download/{accountId}/{blobId}/{name}?type={type}',
      upload: 'https://x.test/jmap/upload/{accountId}',
      eventSource:
        'https://x.test/jmap/events?types={types}&closeafter={closeafter}&ping={ping}',
    });
  });

  it('asks for authentication on every endpoint', async () => {
    const { handle } = setup();
    for (const [method, path] of [
      ['GET', '/.well-known/jmap'],
      ['POST', '/jmap/api'],
      ['POST', '/jmap/upload/acc1'],
      ['GET', '/jmap/download/acc1/blob/name'],
    ]) {
      const response = await handle(new Request(`${BASE}${path}`, { method }));
      expect(response.status, path).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        'Basic realm="test", Bearer',
      );
      expect(response.headers.get('content-type')).toBe(
        'application/problem+json',
      );
    }
  });

  it('serves the session', async () => {
    const { call } = setup();
    const response = await call('/.well-known/jmap');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const session = await body(response);
    expect(session.apiUrl).toBe(`${BASE}/jmap/api`);
    expect(session.username).toBe('me');
    expect(Object.keys(session.accounts)).toEqual(['acc1']);
  });

  it('runs method calls', async () => {
    const { api } = setup();
    const response = await api([['Core/echo', { hello: 1 }, 'c1']]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await body(response)).methodResponses).toEqual([
      ['Core/echo', { hello: 1 }, 'c1'],
    ]);
  });

  it('rejects bodies that are not JSON requests', async () => {
    const { call } = setup();
    const post = (content: string | Uint8Array, contentType: string) =>
      call('/jmap/api', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: content,
      });

    const wrongType = await post('{}', 'text/plain');
    expect(wrongType.status).toBe(400);
    expect((await body(wrongType)).type).toBe(
      'urn:ietf:params:jmap:error:notJSON',
    );

    const broken = await post('{nope', 'application/json');
    expect((await body(broken)).type).toBe(
      'urn:ietf:params:jmap:error:notJSON',
    );

    const invalidUtf8 = await post(
      new Uint8Array([0x7b, 0xff, 0x7d]),
      'application/json',
    );
    expect((await body(invalidUtf8)).type).toBe(
      'urn:ietf:params:jmap:error:notJSON',
    );

    const notRequest = await post(
      '{"using":[]}',
      'application/json; charset=utf-8',
    );
    expect((await body(notRequest)).type).toBe(
      'urn:ietf:params:jmap:error:notRequest',
    );
  });

  it('enforces the request and upload size limits', async () => {
    const { call } = setup({ maxSizeRequest: 64, maxSizeUpload: 8 });
    const bigRequest = await call('/jmap/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        using: USING,
        methodCalls: [],
        padding: 'x'.repeat(100),
      }),
    });
    expect(bigRequest.status).toBe(413);
    expect(await body(bigRequest)).toMatchObject({
      type: 'urn:ietf:params:jmap:error:limit',
      limit: 'maxSizeRequest',
    });

    const bigUpload = await call('/jmap/upload/acc1', {
      method: 'POST',
      body: 'x'.repeat(9),
    });
    expect(bigUpload.status).toBe(413);
    expect((await body(bigUpload)).limit).toBe('maxSizeUpload');
  });

  it('uploads, imports and downloads through the session URLs', async () => {
    const { server, call, api } = setup();
    await server.provisionAccount(AUTH);
    const raw = buildMessage({
      subject: 'Over HTTP',
      attachment: { name: 'a.txt', type: 'text/plain', base64: 'aGVsbG8=' },
    });

    const uploaded = await call('/jmap/upload/acc1', {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822' },
      body: raw,
    });
    expect(uploaded.status).toBe(201);
    const { blobId, size, type } = await body(uploaded);
    expect({ size, type }).toEqual({
      size: raw.length,
      type: 'message/rfc822',
    });

    const imported = await api([
      ['Mailbox/query', { accountId: 'acc1', filter: { role: 'inbox' } }, 'q'],
      [
        'Email/import',
        { accountId: 'acc1', emails: { m: { blobId, mailboxIds: {} } } },
        'i',
      ],
    ]);
    const inbox = (await body(imported)).methodResponses[0][1].ids[0];
    const second = await api([
      [
        'Email/import',
        {
          accountId: 'acc1',
          emails: { m: { blobId, mailboxIds: { [inbox]: true } } },
        },
        'i',
      ],
      [
        'Email/get',
        {
          accountId: 'acc1',
          '#ids': {
            resultOf: 'i',
            name: 'Email/import',
            path: '/created/m/id',
          },
        },
        'g',
      ],
    ]);
    const created = (await body(second)).methodResponses[0][1].created.m;

    const message = await call(
      `/jmap/download/acc1/${created.blobId}/mail.eml?type=${encodeURIComponent('message/rfc822')}`,
    );
    expect(message.status).toBe(200);
    expect(message.headers.get('content-type')).toBe('message/rfc822');
    expect(await message.text()).toBe(raw);

    const part = await call(
      `/jmap/download/acc1/${created.blobId}-2/..%2F..%2Fevil%22name.txt?type=text/html`,
    );
    expect(await part.text()).toBe('hello');
    expect(part.headers.get('content-disposition')).toBe(
      'attachment; filename=".._.._evil_name.txt"',
    );
    expect(part.headers.get('x-content-type-options')).toBe('nosniff');
    expect(part.headers.get('content-security-policy')).toContain('sandbox');

    const oddType = await call(
      `/jmap/download/acc1/${created.blobId}/x?type=${encodeURIComponent('text/html\r\nX-Evil: 1')}`,
    );
    expect(oddType.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(oddType.headers.get('x-evil')).toBeNull();
  });

  it('never asks storage for an object that cannot exist', async () => {
    // Some stores answer "forbidden" for a missing object. A part download must not trip over that.
    const storage = new InMemoryStorageAdapter();
    const asked: string[] = [];
    const get = storage.blobs.get.bind(storage.blobs);
    storage.blobs.get = async (accountId, blobId) => {
      asked.push(blobId);
      const found = await get(accountId, blobId);
      if (!found) throw new Error('AccessDenied');
      return found;
    };
    const server = createJmapServer({ storage, urls: jmapUrls(BASE) });
    await server.provisionAccount(AUTH);
    const imported = await server.importMessage(
      AUTH,
      new TextEncoder().encode(buildMessage({ text: 'part one' })),
      { mailboxRole: 'inbox' },
    );
    asked.length = 0;

    const part = await server.download(
      AUTH,
      AUTH.accountId,
      `${imported.blobId}-1`,
    );
    expect(new TextDecoder().decode(part ?? new Uint8Array()).trim()).toBe(
      'part one',
    );
    expect(
      await server.download(AUTH, AUTH.accountId, `${imported.blobId}-9`),
    ).toBeNull();
    expect(asked).toEqual([imported.blobId, imported.blobId]);
  });

  it('answers 404 for unknown paths, blobs and accounts', async () => {
    const { call, handle } = setup();
    for (const path of [
      '/',
      '/jmap',
      '/jmap/events',
      '/jmap/api/extra',
      '/jmap/download/acc1/missing/name',
      '/jmap/download/other/blob/name',
      '/jmap/download/acc1/%E0%A4%A/name',
    ]) {
      expect((await call(path)).status, path).toBe(404);
    }
    expect((await call('/jmap/api')).status).toBe(404);
    expect(
      (await call('/jmap/upload/other', { method: 'POST', body: 'x' })).status,
    ).toBe(404);
    // Unknown paths do not reveal whether authentication would have succeeded.
    expect((await handle(new Request(`${BASE}/nothing`))).status).toBe(404);
  });

  it('hides unexpected errors and reports them', async () => {
    const { server, call, errors } = setup();
    server.getSession = () => {
      throw new Error('secret detail');
    };
    const response = await call('/.well-known/jmap');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret detail');
    expect(errors).toHaveLength(1);
  });
});
