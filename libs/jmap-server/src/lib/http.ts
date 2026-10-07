import { REQUEST_ERROR, RequestError } from '@mailless/jmap-core';
import type { AuthContext } from './context.js';
import type { JmapServer, JmapServerUrls } from './server.js';

export interface FetchHandlerOptions {
  server: JmapServer;
  /** Identifies the caller, or returns null when the request is not authenticated. */
  authenticate(request: Request): Promise<AuthContext | null>;
  /** Value of the WWW-Authenticate header sent with 401 responses. */
  challenge?: string;
  /** Called with unexpected errors, which the client only sees as a 500. */
  onError?(error: unknown): void;
}

/** The URLs to give `createJmapServer` so that they match the routes of `createFetchHandler`. */
export function jmapUrls(baseUrl: string): JmapServerUrls {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    api: `${base}/jmap/api`,
    download: `${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    upload: `${base}/jmap/upload/{accountId}`,
    eventSource: `${base}/jmap/events?types={types}&closeafter={closeafter}&ping={ping}`,
  };
}

const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+(\s*;[^\r\n]*)?$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function problem(
  error: RequestError,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(error.toProblemDetails()), {
    status: error.status,
    headers: {
      'Content-Type': 'application/problem+json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

const notFound = () =>
  new RequestError('about:blank', 'Not found', { status: 404 });

async function readBody(
  request: Request,
  maxBytes: number,
  limit: string,
): Promise<Uint8Array> {
  const tooLarge = () =>
    new RequestError(
      REQUEST_ERROR.limit,
      `The body may be at most ${maxBytes} bytes`,
      { status: 413, limit },
    );
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > maxBytes) throw tooLarge();
  return body;
}

/**
 * The JMAP HTTP endpoints as a function from a Fetch API Request to a
 * Response, so the same code runs on Node, Lambda, Workers or anything else
 * that can build a Request.
 *
 *   GET  /.well-known/jmap                               session
 *   POST /jmap/api                                       method calls
 *   POST /jmap/upload/{accountId}                        upload a blob
 *   GET  /jmap/download/{accountId}/{blobId}/{name}      download a blob
 */
export function createFetchHandler(
  options: FetchHandlerOptions,
): (request: Request) => Promise<Response> {
  const { server } = options;
  const challenge = options.challenge ?? 'Bearer';

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let segments: string[];
    try {
      segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
    } catch {
      throw notFound();
    }
    const [first, second] = segments;
    const method = request.method;

    const isSession =
      method === 'GET' &&
      segments.length === 2 &&
      first === '.well-known' &&
      second === 'jmap';
    const isApi =
      method === 'POST' &&
      segments.length === 2 &&
      first === 'jmap' &&
      second === 'api';
    const isUpload =
      method === 'POST' &&
      segments.length === 3 &&
      first === 'jmap' &&
      second === 'upload';
    const isDownload =
      method === 'GET' &&
      segments.length >= 5 &&
      first === 'jmap' &&
      second === 'download';
    if (!isSession && !isApi && !isUpload && !isDownload) throw notFound();

    const auth = await options.authenticate(request);
    if (!auth) {
      return problem(
        new RequestError('about:blank', 'Authentication required', {
          status: 401,
        }),
        { 'WWW-Authenticate': challenge },
      );
    }

    if (isSession) return json(200, server.getSession(auth));

    if (isApi) {
      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new RequestError(
          REQUEST_ERROR.notJSON,
          'The Content-Type must be application/json',
        );
      }
      const body = await readBody(
        request,
        server.limits.maxSizeRequest,
        'maxSizeRequest',
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(body),
        );
      } catch {
        throw new RequestError(
          REQUEST_ERROR.notJSON,
          'The body is not valid JSON',
        );
      }
      return json(200, await server.handleRequest(parsed, auth));
    }

    if (isUpload) {
      const body = await readBody(
        request,
        server.limits.maxSizeUpload,
        'maxSizeUpload',
      );
      const type =
        request.headers.get('content-type') ?? 'application/octet-stream';
      return json(
        201,
        await server.upload(auth, segments[2] as string, body, type),
      );
    }

    const data = await server.download(
      auth,
      segments[2] as string,
      segments[3] as string,
    );
    if (!data) throw notFound();
    const requestedType = url.searchParams.get('type') ?? '';
    // Some gateways decode the path before it gets here, so a name may arrive split on its slashes.
    const name = segments
      .slice(4)
      .join('/')
      .replace(/[^\w.-]/g, '_');
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': MEDIA_TYPE.test(requestedType)
          ? requestedType
          : 'application/octet-stream',
        // The type comes from the URL, so a browser must never render the content in this origin.
        'Content-Disposition': `attachment; filename="${name}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'private, immutable, max-age=31536000',
      },
    });
  }

  return async (request) => {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof RequestError) return problem(error);
      options.onError?.(error);
      return problem(
        new RequestError('about:blank', 'Internal server error', {
          status: 500,
        }),
      );
    }
  };
}
