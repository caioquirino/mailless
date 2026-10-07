/**
 * A local JMAP server over in-memory storage, for trying the libraries with
 * curl or a JMAP client. Nothing is persisted and there is one fixed account;
 * it is not meant to be exposed beyond localhost.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createJmapServer, type JmapServer } from '@mailless/jmap-server';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';

const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 8080);
const token = process.env['MAILLESS_DEV_TOKEN'] ?? 'dev-token';
const baseUrl = process.env['BASE_URL'] ?? `http://${host}:${port}`;
const auth = { accountId: 'dev', username: 'dev@mailless.test' };

const jmap: JmapServer = createJmapServer({
  storage: new InMemoryStorageAdapter(),
  urls: jmapUrls(baseUrl),
  onError: (error, method) => console.error(`${method} failed:`, error),
  // There is nowhere to send mail to from here, so everything sent comes back to the inbox.
  transport: {
    send: async (message, envelope) => {
      await jmap.importMessage(auth, message, { mailboxRole: 'inbox' });
      // Report the delivery a moment later, as a real transport would.
      const submissionId = envelope.tags?.['submission'];
      if (submissionId) {
        setTimeout(() => {
          void jmap.recordDelivery(
            auth,
            submissionId,
            Object.fromEntries(
              envelope.rcptTo.map((recipient) => [
                recipient,
                {
                  delivered: 'yes' as const,
                  smtpReply: '250 Delivered to the dev inbox',
                },
              ]),
            ),
          );
        }, 1000);
      }
    },
  },
  identities: () => [
    {
      id: 'dev',
      email: 'dev@mailless.test',
      name: 'Dev',
      allowedFrom: ['*@mailless.test'],
    },
  ],
});

// The token is accepted as a bearer token, or as the password of any username over Basic.
function matchesToken(candidate: string): boolean {
  const given = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const handle = createFetchHandler({
  server: jmap,
  authenticate: async (request) => {
    const [scheme, value = ''] = (
      request.headers.get('authorization') ?? ''
    ).split(' ');
    if (scheme?.toLowerCase() === 'bearer')
      return matchesToken(value) ? auth : null;
    if (scheme?.toLowerCase() === 'basic') {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      return matchesToken(decoded.slice(decoded.indexOf(':') + 1))
        ? auth
        : null;
    }
    return null;
  },
  challenge: 'Basic realm="mailless-dev", Bearer',
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
  console.log(
    `Sign in with the token ${token}, as a bearer token or as the password of any user.`,
  );
});
