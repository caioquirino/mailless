import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createLambdaHttpHandler } from './lambda-http.js';

function event(overrides: {
  method?: string;
  path?: string;
  query?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  domainName?: string;
}): APIGatewayProxyEventV2 {
  return {
    rawPath: overrides.path ?? '/',
    rawQueryString: overrides.query ?? '',
    headers: overrides.headers ?? {},
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    requestContext: {
      domainName:
        overrides.domainName ?? 'abc.execute-api.eu-central-1.amazonaws.com',
      http: { method: overrides.method ?? 'GET' },
    },
  } as unknown as APIGatewayProxyEventV2;
}

/** A handler that reports what it received, so the conversion can be inspected. */
function echoing() {
  const created: string[] = [];
  const handle = createLambdaHttpHandler({
    createHandler: (baseUrl) => {
      created.push(baseUrl);
      return async (request) =>
        Response.json({
          url: request.url,
          method: request.method,
          authorization: request.headers.get('authorization'),
          body: Buffer.from(await request.arrayBuffer()).toString('hex'),
        });
    },
  });
  return { handle, created };
}

describe('createLambdaHttpHandler', () => {
  it('rebuilds the request from the event', async () => {
    const { handle } = echoing();
    const result = await handle(
      event({
        method: 'POST',
        path: '/jmap/api',
        query: 'a=1&b=2',
        headers: {
          authorization: 'Bearer x',
          'content-type': 'application/json',
        },
        body: '{"é":1}',
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(JSON.parse(result.body as string)).toEqual({
      url: 'https://abc.execute-api.eu-central-1.amazonaws.com/jmap/api?a=1&b=2',
      method: 'POST',
      authorization: 'Bearer x',
      body: Buffer.from('{"é":1}').toString('hex'),
    });
  });

  it('decodes base64 request bodies', async () => {
    const { handle } = echoing();
    const result = await handle(
      event({
        method: 'POST',
        path: '/jmap/upload/acc',
        body: Buffer.from([0, 255, 16]).toString('base64'),
        isBase64Encoded: true,
      }),
    );
    expect(JSON.parse(result.body as string).body).toBe('00ff10');
  });

  it('uses the configured public URL and builds one handler per URL', async () => {
    const created: string[] = [];
    const handle = createLambdaHttpHandler({
      publicUrl: 'https://mail.example.com',
      createHandler: (baseUrl) => {
        created.push(baseUrl);
        return async (request) => new Response(request.url);
      },
    });
    const first = await handle(
      event({ path: '/.well-known/jmap', domainName: 'internal' }),
    );
    await handle(event({ path: '/.well-known/jmap' }));
    expect(first.body).toBe('https://mail.example.com/.well-known/jmap');
    expect(created).toEqual(['https://mail.example.com']);

    const dynamic = echoing();
    await dynamic.handle(event({ domainName: 'one.example' }));
    await dynamic.handle(event({ domainName: 'two.example' }));
    await dynamic.handle(event({ domainName: 'one.example' }));
    expect(dynamic.created).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
  });

  it('returns binary bodies base64-encoded with their headers', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const handle = createLambdaHttpHandler({
      createHandler: () => async () =>
        new Response(bytes, {
          headers: {
            'content-type': 'application/pdf',
            'x-content-type-options': 'nosniff',
          },
        }),
    });
    const result = await handle(event({ path: '/jmap/download/a/b/c' }));
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body as string, 'base64')).toEqual(
      Buffer.from(bytes),
    );
    expect(result.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
    });
  });

  it('passes error statuses and headers through', async () => {
    const handle = createLambdaHttpHandler({
      createHandler: () => async () =>
        new Response('{"status":401}', {
          status: 401,
          headers: {
            'content-type': 'application/problem+json',
            'www-authenticate': 'Basic realm="x"',
          },
        }),
    });
    const result = await handle(event({}));
    expect(result).toMatchObject({
      statusCode: 401,
      body: '{"status":401}',
      isBase64Encoded: false,
      headers: { 'www-authenticate': 'Basic realm="x"' },
    });
  });

  it('redirects oversized downloads to an offloaded copy', async () => {
    const offloaded: Array<{ size: number; type: string | null }> = [];
    const make = (size: number, status = 200) =>
      createLambdaHttpHandler({
        offloadThresholdBytes: 10,
        offload: async (body, headers) => {
          offloaded.push({
            size: body.length,
            type: headers.get('content-type'),
          });
          return 'https://bucket.example/signed';
        },
        createHandler: () => async () =>
          new Response(new Uint8Array(size), {
            status,
            headers: { 'content-type': 'image/png' },
          }),
      });

    const big = await make(11)(event({ path: '/jmap/download/a/b/c' }));
    expect(big).toEqual({
      statusCode: 302,
      headers: {
        Location: 'https://bucket.example/signed',
        'Cache-Control': 'no-store',
      },
    });
    expect(offloaded).toEqual([{ size: 11, type: 'image/png' }]);

    expect((await make(10)(event({}))).statusCode).toBe(200);
    expect((await make(11, 404)(event({}))).statusCode).toBe(404);
    expect(
      (await make(11)(event({ method: 'POST', body: 'x' }))).statusCode,
    ).toBe(200);
    expect(offloaded).toHaveLength(1);
  });
});
