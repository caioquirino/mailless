import type { Hono } from 'hono';
import { createSite, origin, type WebAssets } from '../web/site.js';

export type { WebAssets };

/*
 * Serves the webmail: a handful of static files and the configuration the
 * pages need to sign someone in and to find the mail server. The pages are
 * public; the mail is reached through the JMAP API, which is not.
 */

/** What the pages need to know to sign someone in and to reach the mail. */
export interface WebmailConfiguration {
  /** Where the mail server describes itself. */
  sessionUrl: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  logoutUrl: string;
  /** Where a refresh token is taken back on signing out, when the provider has such a place. */
  revokeUrl: string | null;
  scopes: string[];
  /** Where someone manages their password and app passwords. */
  accountUrl: string | null;
}

export interface WebmailOptions {
  assets: WebAssets;
  configuration: WebmailConfiguration;
  /** Where the application is mounted, such as `/mail`: a file's path is what follows it. */
  mountedAt?: string;
}

/** Reads the configuration for the pages from the environment, as a deployment sets it. */
export function webmailConfigurationFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): WebmailConfiguration {
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
    // On the same site as the pages, whatever name that site goes by.
    sessionUrl: '/.well-known/jmap',
    clientId: required('WEBMAIL_CLIENT_ID'),
    authorizeUrl: required('AUTH_AUTHORIZE_URL'),
    tokenUrl: required('AUTH_TOKEN_URL'),
    logoutUrl: required('AUTH_LOGOUT_URL'),
    revokeUrl: env['AUTH_REVOKE_URL'] || null,
    scopes: scopes as string[],
    accountUrl: env['ACCOUNT_URL'] || null,
  };
}

/**
 * The headers every page is sent with. Scripts come from this site only and
 * nothing inline runs, so a page that was somehow made to carry someone
 * else's script cannot run it, and cannot reach the token the page holds.
 *
 * A message written in HTML is shown in a frame that takes this policy on
 * and adds a stricter one of its own. Two things here are looser than they
 * would be without mail to show, because the frame can only narrow them:
 * styles written into a page, which is how messages are styled, and pictures
 * from other sites, which the frame lets through only when the reader asks.
 * The pages themselves use neither.
 */
export function webmailSecurityHeaders(
  configuration: WebmailConfiguration,
): Record<string, string> {
  const provider = [
    ...new Set(
      [
        configuration.tokenUrl,
        configuration.authorizeUrl,
        configuration.revokeUrl ?? undefined,
      ]
        .map((url) => (url === undefined ? undefined : origin(url)))
        .filter((value): value is string => value !== undefined),
    ),
  ].join(' ');
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // `blob:` is a picture being put in a message, shown from the copy this browser holds of it.
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data:",
      `connect-src 'self' ${provider}`.trim(),
      `form-action 'self' ${provider}`.trim(),
      // A message's frame is filled in by the page; nothing is loaded into one from anywhere.
      "frame-src 'self'",
      // The worker that shows notifications, and what a phone needs to install the page.
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // The address a sign-in comes back to carries a one-time code, and a link
    // in a message is followed from an address that names a conversation.
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** The webmail as an application to mount under `/mail`. */
export function createWebmail(options: WebmailOptions): Hono {
  return createSite({
    assets: options.assets,
    configuration: options.configuration,
    headers: webmailSecurityHeaders(options.configuration),
    ...(options.mountedAt ? { mountedAt: options.mountedAt } : {}),
  });
}
