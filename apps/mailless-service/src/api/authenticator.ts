import type { AuthContext } from '@mailless/jmap-server';

export interface AuthenticatorOptions {
  /** Verifies an access token and returns the username it was issued to. Throws when invalid. */
  verifyAccessToken(token: string): Promise<string>;
  /** Signs in with a password and returns an access token, or null when the credentials are refused. */
  passwordLogin(username: string, password: string): Promise<string | null>;
  now?(): number;
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCEPTED_TTL_MS = 5 * 60_000;
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
        const token = await options.passwordLogin(
          credentials.username,
          credentials.password,
        );
        // Verifying the token yields the canonical username, whatever spelling was typed.
        const auth = token === null ? null : await bearer(token);

        if (cache.size >= MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value as string);
        }
        cache.set(key, {
          auth,
          expires: now() + (auth ? ACCEPTED_TTL_MS : REFUSED_TTL_MS),
        });
        return auth;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  }

  return async (request) => {
    const header = request.headers.get('authorization') ?? '';
    const space = header.indexOf(' ');
    if (space <= 0) return null;
    const scheme = header.slice(0, space).toLowerCase();
    const value = header.slice(space + 1).trim();
    if (!value) return null;

    if (scheme === 'bearer') return bearer(value);
    if (scheme === 'basic') return basic(value);
    return null;
  };
}
