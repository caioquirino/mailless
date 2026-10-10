import type { SessionConfig } from '@mailless/web-session';

/**
 * What the page needs to know about where it is running, handed over by the
 * server that serves it. Nothing about the identity provider or the mail
 * server is written into the page: only these addresses.
 */
export interface AppConfig extends SessionConfig {
  /** Where the mail server describes itself: `/.well-known/jmap`. */
  sessionUrl: string;
  /** Where someone manages their password and app passwords, when there is such a place. */
  accountUrl: string | null;
}

const TEXTS = [
  'sessionUrl',
  'clientId',
  'authorizeUrl',
  'tokenUrl',
  'logoutUrl',
] as const;

/** Checks what the server sent, so that a broken deployment says so at once. */
export function parseConfig(value: unknown): AppConfig {
  const record = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Record<string, unknown>;
  for (const name of TEXTS) {
    if (typeof record[name] !== 'string' || record[name] === '') {
      throw new Error(`The configuration has no ${name}`);
    }
  }
  const scopes = record['scopes'];
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === 'string')
  ) {
    throw new Error('The configuration has no scopes');
  }
  const account = record['accountUrl'];
  return {
    sessionUrl: record['sessionUrl'] as string,
    clientId: record['clientId'] as string,
    authorizeUrl: record['authorizeUrl'] as string,
    tokenUrl: record['tokenUrl'] as string,
    logoutUrl: record['logoutUrl'] as string,
    revokeUrl:
      typeof record['revokeUrl'] === 'string' && record['revokeUrl'] !== ''
        ? record['revokeUrl']
        : null,
    scopes: scopes as string[],
    accountUrl: typeof account === 'string' && account !== '' ? account : null,
  };
}

/**
 * Whether this is the application installed on a device, in a window of its
 * own, and not a tab of a browser: closing that is not leaving it.
 */
export function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    // Safari on a phone says so its own way.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** The address the page is served under, ending in "/": `https://host/mail/`. */
export function appBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).href;
}

export async function loadConfig(
  fetcher: typeof fetch = fetch,
): Promise<AppConfig> {
  const response = await fetcher(new URL('config.json', appBaseUrl()).href, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `The configuration could not be loaded (${response.status})`,
    );
  }
  return parseConfig(await response.json());
}
