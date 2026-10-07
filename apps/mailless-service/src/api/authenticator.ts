import type { AuthContext } from '@mailless/jmap-server';

export interface AuthenticatorOptions {
  /** Verifies an access token and returns the username it was issued to. Throws when invalid. */
  verifyAccessToken(token: string): Promise<string>;
  /** Signs in with a password and returns an access token, or null when the credentials are refused. */
  passwordLogin(username: string, password: string): Promise<string | null>;
  /**
   * Maps what was typed as the username to the sign-in name. Mail clients ask
   * for an email address, so this is where an address becomes its account.
   */
  resolveUsername?(username: string): string;
  /**
   * Checks an app password for a sign-in name and returns that name when it
   * is valid. Passwords are routed here when `isAppPassword` says so.
   */
  appPasswordLogin?(username: string, password: string): Promise<string | null>;
  isAppPassword?(password: string): boolean;
  /**
   * Whether the account's own password may be used over Basic authentication.
   * Turn it off once every client uses an app password.
   */
  allowPasswordLogin?: boolean;
  /** Told why a request was not authenticated. Never receives the credentials themselves. */
  onFailure?(reason: AuthFailure): void;
  now?(): number;
}

export interface AuthFailure {
  /** The Authorization scheme used, or "none" when the header was absent. */
  scheme: string;
  reason:
    | 'missing'
    | 'malformed'
    | 'unsupported-scheme'
    | 'refused'
    | 'password-sign-in-disabled';
  /** For Basic: whether an app password or the account's own password was offered. */
  credentialKind?: 'app-password' | 'password';
  /** For Basic: whether the username was an email address or a plain name. */
  usernameKind?: 'address' | 'name';
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCEPTED_TTL_MS = 5 * 60_000;
/** Shorter for app passwords, so that revoking one takes effect within a minute. */
const APP_PASSWORD_TTL_MS = 60_000;
const REFUSED_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 1000;

type CacheEntry = { auth: AuthContext | null; expires: number };

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Buffer.from(bytes).toString('hex');
}

function toAuth(username: string): AuthContext | null {
  // The username doubles as the account id, so it must be safe to use as one.
  return ACCOUNT_ID.test(username) ? { accountId: username, username } : null;
}

function parseBasic(
  encoded: string,
): { username: string; password: string } | null {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(encoded, 'base64'),
    );
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon <= 0 || colon === decoded.length - 1) return null;
  return {
    username: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
  };
}

/**
 * Accepts `Authorization: Bearer <access token>` and `Authorization: Basic`.
 * Basic credentials are checked with the identity provider, and the outcome
 * is remembered for a few minutes so that a client making many requests does
 * not cause a sign-in each time. Passwords are never stored: the cache key is
 * a hash of the header.
 */
export function createAuthenticator(
  options: AuthenticatorOptions,
): (request: Request) => Promise<AuthContext | null> {
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<AuthContext | null>>();

  const isAppPassword = (password: string): boolean =>
    options.appPasswordLogin !== undefined &&
    (options.isAppPassword?.(password) ?? false);

  async function bearer(token: string): Promise<AuthContext | null> {
    try {
      return toAuth(await options.verifyAccessToken(token));
    } catch {
      return null;
    }
  }

  async function basic(encoded: string): Promise<AuthContext | null> {
    const credentials = parseBasic(encoded);
    if (!credentials) return null;

    const key = await digest(encoded);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.auth;

    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const username =
          options.resolveUsername?.(credentials.username) ??
          credentials.username;
        let auth: AuthContext | null;
        let acceptedFor = ACCEPTED_TTL_MS;

        if (isAppPassword(credentials.password)) {
          // An app password is never offered to the identity provider.
          const name = await options.appPasswordLogin?.(
            username,
            credentials.password,
          );
          auth = name ? toAuth(name) : null;
          acceptedFor = APP_PASSWORD_TTL_MS;
        } else if (options.allowPasswordLogin === false) {
          auth = null;
        } else {
          const token = await options.passwordLogin(
            username,
            credentials.password,
          );
          // Verifying the token yields the canonical username, whatever spelling was typed.
          auth = token === null ? null : await bearer(token);
        }

        if (cache.size >= MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value as string);
        }
        cache.set(key, {
          auth,
          expires: now() + (auth ? acceptedFor : REFUSED_TTL_MS),
        });
        return auth;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  }

  return async (request) => {
    const header = request.headers.get('authorization') ?? '';
    const fail = (failure: AuthFailure): null => {
      options.onFailure?.(failure);
      return null;
    };
    if (!header) return fail({ scheme: 'none', reason: 'missing' });

    const space = header.indexOf(' ');
    const scheme = (space <= 0 ? header : header.slice(0, space)).toLowerCase();
    const value = space <= 0 ? '' : header.slice(space + 1).trim();
    // Only the scheme name is ever reported, and only when it is one of the usual ones.
    const reported = ['basic', 'bearer', 'digest', 'negotiate'].includes(scheme)
      ? scheme
      : 'other';
    if (!value) return fail({ scheme: reported, reason: 'malformed' });

    if (scheme === 'bearer') {
      return (
        (await bearer(value)) ?? fail({ scheme: reported, reason: 'refused' })
      );
    }
    if (scheme === 'basic') {
      const credentials = parseBasic(value);
      if (!credentials) return fail({ scheme: reported, reason: 'malformed' });
      const offeredAppPassword = isAppPassword(credentials.password);
      return (
        (await basic(value)) ??
        fail({
          scheme: reported,
          reason:
            !offeredAppPassword && options.allowPasswordLogin === false
              ? 'password-sign-in-disabled'
              : 'refused',
          credentialKind: offeredAppPassword ? 'app-password' : 'password',
          usernameKind: credentials.username.includes('@') ? 'address' : 'name',
        })
      );
    }
    return fail({ scheme: reported, reason: 'unsupported-scheme' });
  };
}
