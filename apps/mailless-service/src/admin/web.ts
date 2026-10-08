import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';

/*
 * Serves the admin interface: a handful of static files and the configuration
 * the pages need to sign someone in. The pages are public; everything they do
 * goes through the API, which is not.
 */

/** The files of the built interface, by path. Text is kept compressed. */
export type WebAssets = Record<
  string,
  { type: string; gzip: boolean; body: string }
>;

/** What the pages need to know to sign someone in and to call the API. */
export interface WebConfiguration {
  apiBaseUrl: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  logoutUrl: string;
  scopes: string[];
  passkeyEnrolmentUrl: string | null;
}

export interface AdminWebOptions {
  assets: WebAssets;
  configuration: WebConfiguration;
  /** Where the application is mounted, such as `/admin`: a file's path is what follows it. */
  mountedAt?: string;
}

function origin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Reads the configuration for the pages from the environment, as a deployment sets it. */
export function webConfigurationFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): WebConfiguration {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
  };
  const scopes: unknown = JSON.parse(env['AUTH_SCOPES'] ?? '["openid"]');
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === 'string')
  ) {
    throw new Error('AUTH_SCOPES must be a JSON list of texts');
  }
  return {
    apiBaseUrl: '/admin/api',
    clientId: required('ADMIN_CLIENT_ID'),
    authorizeUrl: required('AUTH_AUTHORIZE_URL'),
    tokenUrl: required('AUTH_TOKEN_URL'),
    logoutUrl: required('AUTH_LOGOUT_URL'),
    scopes: scopes as string[],
    passkeyEnrolmentUrl: env['PASSKEY_ENROLMENT_URL'] || null,
  };
}

/**
 * The headers every page is sent with. Scripts and styles come from this
 * site only, and nothing inline runs: a page that was somehow made to carry
 * someone else's script cannot run it, and so cannot reach the token the
 * page holds. The only other place the pages talk to is the identity
 * provider, to exchange a sign-in for a token.
 */
export function securityHeaders(
  configuration: WebConfiguration,
): Record<string, string> {
  const provider = [
    ...new Set(
      [configuration.tokenUrl, configuration.authorizeUrl]
        .map(origin)
        .filter((value): value is string => value !== undefined),
    ),
  ].join(' ');
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ${provider}`.trim(),
      `form-action 'self' ${provider}`.trim(),
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // The address a sign-in comes back to carries a one-time code. It is told to nobody.
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** The interface as an application to mount under `/admin`. */
export function createAdminWeb(options: AdminWebOptions): Hono {
  const { assets, configuration } = options;
  const mountedAt = (options.mountedAt ?? '').replace(/\/+$/, '');
  const headers = securityHeaders(configuration);
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) {
      c.header(name, value);
    }
  });

  app.get('/config.json', (c) => {
    // Never kept: a deployment that changes its sign-in settings is believed at once.
    c.header('cache-control', 'no-store');
    return c.json(configuration);
  });

  app.get('*', (c) => {
    const requested = c.req.path;
    const path = (
      mountedAt && requested.startsWith(mountedAt)
        ? requested.slice(mountedAt.length)
        : requested
    ).replace(/^\/+/, '');
    // Anything that is not a file is an address inside the interface, which the pages work out themselves.
    const isFile = Object.prototype.hasOwnProperty.call(assets, path);
    const name = isFile ? path : 'index.html';
    const asset = assets[name];
    if (!asset || (!isFile && /\.[a-z0-9]+$/i.test(path))) {
      // A file that is asked for by name and is not there is not there.
      return c.text('Not found', 404);
    }

    c.header('content-type', asset.type);
    c.header(
      'cache-control',
      // Built files carry a digest of their content in their name, so they never change.
      name.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    );
    const data = Buffer.from(asset.body, 'base64');
    if (!asset.gzip) return c.body(new Uint8Array(data));
    c.header('vary', 'accept-encoding');
    if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
      c.header('content-encoding', 'gzip');
      return c.body(new Uint8Array(data));
    }
    return c.body(new Uint8Array(gunzipSync(data)));
  });

  return app;
}
