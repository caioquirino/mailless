/**
 * A local JMAP server over in-memory storage, for trying the libraries with
 * curl or a JMAP client. Nothing is persisted and there is one fixed account;
 * it is not meant to be exposed beyond localhost.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { REQUEST_ERROR, RequestError } from '@mailless/jmap-core';
import { createJmapServer, DEFAULT_LIMITS } from '@mailless/jmap-server';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';

const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 8080);
const token = process.env['MAILLESS_DEV_TOKEN'] ?? 'dev-token';
const baseUrl = process.env['BASE_URL'] ?? `http://${host}:${port}`;
const auth = { accountId: 'dev', username: 'dev@mailless.test' };

const jmap = createJmapServer({
  storage: new InMemoryStorageAdapter(),
  urls: {
    api: `${baseUrl}/jmap/api`,
    download: `${baseUrl}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    upload: `${baseUrl}/jmap/upload/{accountId}`,
    eventSource: `${baseUrl}/jmap/events?types={types}&closeafter={closeafter}&ping={ping}`,
  },
  onError: (error, method) => console.error(`${method} failed:`, error),
});

function isAuthorized(request: IncomingMessage): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
  limit: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new RequestError(
        REQUEST_ERROR.limit,
        `The body may be at most ${maxBytes} bytes`,
        { status: 413, limit },
      );
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function sendProblem(response: ServerResponse, error: RequestError): void {
  const payload = JSON.stringify(error.toProblemDetails());
  response.writeHead(error.status, {
    'Content-Type': 'application/problem+json',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

const notFound = () =>
  new RequestError('about:blank', 'Not found', { status: 404 });

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isAuthorized(request)) {
    response.writeHead(401, {
      'WWW-Authenticate': 'Bearer realm="mailless-dev"',
    });
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', baseUrl);
  const method = request.method ?? 'GET';
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw notFound();
  }

  if (method === 'GET' && url.pathname === '/.well-known/jmap') {
    sendJson(response, 200, jmap.getSession(auth));
    return;
  }

  if (method === 'POST' && url.pathname === '/jmap/api') {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      throw new RequestError(
        REQUEST_ERROR.notJSON,
        'The Content-Type must be application/json',
      );
    }
    const body = await readBody(
      request,
      DEFAULT_LIMITS.maxSizeRequest,
      'maxSizeRequest',
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new RequestError(
        REQUEST_ERROR.notJSON,
        'The body is not valid JSON',
      );
    }
    sendJson(response, 200, await jmap.handleRequest(parsed, auth));
    return;
  }

  if (
    method === 'POST' &&
    segments.length === 3 &&
    segments[0] === 'jmap' &&
    segments[1] === 'upload'
  ) {
    const body = await readBody(
      request,
      DEFAULT_LIMITS.maxSizeUpload,
      'maxSizeUpload',
    );
    const type = request.headers['content-type'] ?? 'application/octet-stream';
    sendJson(
      response,
      201,
      await jmap.upload(
        auth,
        segments[2] as string,
        new Uint8Array(body),
        type,
      ),
    );
    return;
  }

  if (
    method === 'GET' &&
    segments.length === 5 &&
    segments[0] === 'jmap' &&
    segments[1] === 'download'
  ) {
    const data = await jmap.download(
      auth,
      segments[2] as string,
      segments[3] as string,
    );
    if (!data) throw notFound();
    const name = (segments[4] as string).replace(/[^\w.-]/g, '_');
    response.writeHead(200, {
      'Content-Type':
        url.searchParams.get('type') ?? 'application/octet-stream',
      'Content-Length': data.length,
      // The type comes from the URL, so never let a browser render the content in this origin.
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, immutable, max-age=31536000',
    });
    response.end(data);
    return;
  }

  throw notFound();
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

async function seed(): Promise<void> {
  await jmap.provisionAccount(auth);
  const response = await jmap.handleRequest(
    {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        [
          'Mailbox/query',
          { accountId: auth.accountId, filter: { role: 'inbox' } },
          'a',
        ],
      ],
    },
    auth,
  );
  const [inbox] = (response.methodResponses[0]?.[1] as { ids: string[] }).ids;
  await jmap.importMessage(auth, new TextEncoder().encode(WELCOME), {
    mailboxIds: { [inbox as string]: true },
  });
}

await seed();

createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof RequestError) {
      sendProblem(response, error);
      return;
    }
    console.error(error);
    sendProblem(
      response,
      new RequestError('about:blank', 'Internal server error', { status: 500 }),
    );
  });
}).listen(port, host, () => {
  console.log(`mailless dev server: ${baseUrl}/.well-known/jmap`);
  console.log(`Authorization: Bearer ${token}`);
});
