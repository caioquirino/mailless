/**
 * A local JMAP server over in-memory storage, for trying the libraries with
 * curl or a JMAP client, and for running test suites against. Nothing is
 * persisted. It is not meant to be exposed beyond localhost.
 *
 * There is one account, `dev`, to begin with. Signing in over Basic with a
 * plain user name (letters, digits, "-" and "_") gives that name an account of
 * its own, created on the spot; this is how tests get an empty account each.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import {
  createJmapServer,
  type AuthContext,
  type JmapServer,
} from '@mailless/jmap-server';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';

const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 8080);
const token = process.env['MAILLESS_DEV_TOKEN'] ?? 'dev-token';
const baseUrl = process.env['BASE_URL'] ?? `http://${host}:${port}`;
const DOMAIN = 'mailless.test';
const auth: AuthContext = { accountId: 'dev', username: `dev@${DOMAIN}` };

const ACCOUNT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const provisioned = new Map<string, Promise<void>>();

/** The account a user name signs in to. Anything that is not a plain name is the dev account. */
async function accountFor(username: string): Promise<AuthContext> {
  const account = ACCOUNT_NAME.test(username)
    ? { accountId: username, username: `${username.toLowerCase()}@${DOMAIN}` }
    : auth;
  let ready = provisioned.get(account.accountId);
  if (!ready) {
    ready = jmap.provisionAccount(account);
    provisioned.set(account.accountId, ready);
  }
  await ready;
  return account;
}

const jmap: JmapServer = createJmapServer({
  storage: new InMemoryStorageAdapter(),
  urls: jmapUrls(baseUrl),
  // Push subscriptions may point anywhere here, including plain http on this machine.
  push: { allowUrl: () => true },
  onStateChange: (accountId, types) =>
    void jmap
      .pushStateChange(accountId, types)
      .catch((error: unknown) => console.error('push failed:', error)),
  onError: (error, method) => console.error(`${method} failed:`, error),
  // There is nowhere to send mail to from here, so everything sent comes back to the sender's inbox.
  transport: {
    send: async (message, envelope) => {
      const sender = await accountFor(envelope.tags?.['account'] ?? '');
      await jmap.importMessage(sender, message, {
        mailboxRole: 'inbox',
        delivery: true,
      });
      // Report the delivery a moment later, as a real transport would.
      const submissionId = envelope.tags?.['submission'];
      if (submissionId) {
        setTimeout(() => {
          void jmap.recordDelivery(
            sender,
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
  identities: (who) => [
    {
      id: who.accountId,
      email: who.username,
      name: who.accountId === auth.accountId ? 'Dev' : who.accountId,
      allowedFrom: [`*@${DOMAIN}`],
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
      const colon = decoded.indexOf(':');
      return matchesToken(decoded.slice(colon + 1))
        ? accountFor(decoded.slice(0, Math.max(colon, 0)))
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

await accountFor(auth.accountId);
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
    `Sign in with the token ${token}, as a bearer token or as the password of any user. A plain user name gets an account of its own.`,
  );
});
