/**
 * What the page needs to know about where it is running, handed over by the
 * server that serves it. Nothing about the identity provider is written into
 * the page: only these addresses.
 */
export interface AppConfig {
  apiBaseUrl: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  logoutUrl: string;
  scopes: string[];
  passkeyEnrolmentUrl: string | null;
}

const TEXTS = [
  'apiBaseUrl',
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
  const passkeys = record['passkeyEnrolmentUrl'];
  return {
    apiBaseUrl: record['apiBaseUrl'] as string,
    clientId: record['clientId'] as string,
    authorizeUrl: record['authorizeUrl'] as string,
    tokenUrl: record['tokenUrl'] as string,
    logoutUrl: record['logoutUrl'] as string,
    scopes: scopes as string[],
    passkeyEnrolmentUrl:
      typeof passkeys === 'string' && passkeys !== '' ? passkeys : null,
  };
}

/** The address the page is served under, ending in "/": `https://host/admin/`. */
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
