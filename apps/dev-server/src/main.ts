/**
 * A local JMAP server over in-memory storage, for trying the libraries with
 * curl or a JMAP client. Nothing is persisted and there is one fixed account;
 * it is not meant to be exposed beyond localhost.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createJmapServer } from '@mailless/jmap-server';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';

const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 8080);
const token = process.env['MAILLESS_DEV_TOKEN'] ?? 'dev-token';
const baseUrl = process.env['BASE_URL'] ?? `http://${host}:${port}`;
const auth = { accountId: 'dev', username: 'dev@mailless.test' };

const jmap = createJmapServer({
  storage: new InMemoryStorageAdapter(),
  urls: jmapUrls(baseUrl),
  onError: (error, method) => console.error(`${method} failed:`, error),
});

const expectedAuthorization = Buffer.from(`Bearer ${token}`);
const handle = createFetchHandler({
  server: jmap,
  authenticate: async (request) => {
    const given = Buffer.from(request.headers.get('authorization') ?? '');
    return given.length === expectedAuthorization.length &&
      timingSafeEqual(given, expectedAuthorization)
      ? auth
      : null;
  },
  challenge: 'Bearer realm="mailless-dev"',
  onError: (error) => console.error(error),
});

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(name, [value].flat().join(', '));
  }
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  const chunks: Buffer[] = [];
  if (hasBody) for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return new Request(new URL(incoming.url ?? '/', baseUrl), {
    method: incoming.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

const WELCOME = [
  'From: mailless <hello@mailless.test>',
  `To: ${auth.username}`,
  'Subject: Welcome to the mailless dev server',
  'Message-ID: <welcome@mailless.test>',
  `Date: ${new Date().toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'This message lives in memory and disappears when the server stops.',
  '',
].join('\r\n');

await jmap.provisionAccount(auth);
await jmap.importMessage(auth, new TextEncoder().encode(WELCOME), {
  mailboxRole: 'inbox',
});

createServer((incoming, outgoing) => {
  toRequest(incoming)
    .then(handle)
    .then(async (response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })
    .catch((error: unknown) => {
      console.error(error);
      outgoing.destroy();
    });
}).listen(port, host, () => {
  console.log(`mailless dev server: ${baseUrl}/.well-known/jmap`);
  console.log(`Authorization: Bearer ${token}`);
});
