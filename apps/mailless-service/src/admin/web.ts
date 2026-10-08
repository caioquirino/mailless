import type { Hono } from 'hono';
import { createSite, origin, type WebAssets } from '../web/site.js';

export type { WebAssets };

/*
 * Serves the admin interface: a handful of static files and the configuration
 * the pages need to sign someone in. The pages are public; everything they do
 * goes through the API, which is not.
 */

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
  return createSite({
    assets: options.assets,
    configuration: options.configuration,
    headers: securityHeaders(options.configuration),
    ...(options.mountedAt ? { mountedAt: options.mountedAt } : {}),
  });
}
