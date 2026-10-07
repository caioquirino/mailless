import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

export interface LambdaHttpOptions {
  /** The request handler for a given public base URL. Called once per distinct URL. */
  createHandler(baseUrl: string): (request: Request) => Promise<Response>;
  /** Fixed public URL. When absent, the host the request arrived on is used. */
  publicUrl?: string | undefined;
  /**
   * Stores a response body that is too large to return through Lambda and
   * gives back a short-lived URL to fetch it from.
   */
  offload?(body: Uint8Array, headers: Headers): Promise<string>;
  /** Bodies above this many bytes are offloaded. */
  offloadThresholdBytes?: number;
}

// Lambda responses are capped at 6 MB and binary bodies grow by a third when base64-encoded.
const DEFAULT_OFFLOAD_THRESHOLD = 4_000_000;

const TEXT_TYPES = /^(application\/(json|problem\+json)|text\/)/i;

/** Adapts API Gateway HTTP API (payload format 2.0) events to a Fetch API handler. */
export function createLambdaHttpHandler(
  options: LambdaHttpOptions,
): (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2> {
  const handlers = new Map<string, (request: Request) => Promise<Response>>();
  const threshold = options.offloadThresholdBytes ?? DEFAULT_OFFLOAD_THRESHOLD;

  return async (event) => {
    const baseUrl =
      options.publicUrl ?? `https://${event.requestContext.domainName}`;
    let handle = handlers.get(baseUrl);
    if (!handle) {
      handle = options.createHandler(baseUrl);
      handlers.set(baseUrl, handle);
    }

    const method = event.requestContext.http.method;
    const headers = new Headers();
    for (const [name, value] of Object.entries(event.headers)) {
      if (value !== undefined) headers.set(name, value);
    }
    const hasBody =
      method !== 'GET' && method !== 'HEAD' && event.body !== undefined;
    const query = event.rawQueryString ? `?${event.rawQueryString}` : '';

    const response = await handle(
      new Request(`${baseUrl.replace(/\/+$/, '')}${event.rawPath}${query}`, {
        method,
        headers,
        ...(hasBody
          ? {
              body: Buffer.from(
                event.body as string,
                event.isBase64Encoded ? 'base64' : 'utf8',
              ),
            }
          : {}),
      }),
    );

    const body = new Uint8Array(await response.arrayBuffer());
    const responseHeaders = Object.fromEntries(response.headers);

    if (
      options.offload &&
      method === 'GET' &&
      response.status === 200 &&
      body.length > threshold
    ) {
      return {
        statusCode: 302,
        headers: {
          Location: await options.offload(body, response.headers),
          'Cache-Control': 'no-store',
        },
      };
    }

    const isText = TEXT_TYPES.test(response.headers.get('content-type') ?? '');
    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: Buffer.from(body).toString(isText ? 'utf8' : 'base64'),
      isBase64Encoded: !isText,
    };
  };
}
