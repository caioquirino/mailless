import { Session, type SessionConfig } from './session.js';

const CONFIG: SessionConfig = {
  clientId: 'client',
  authorizeUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  logoutUrl: 'https://auth.example.com/logout',
  revokeUrl: 'https://auth.example.com/oauth2/revoke',
  scopes: ['openid'],
};
const KEY = 'test.tokens';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  held: Map<string, string>;
} {
  const held = new Map<string, string>();
  return {
    held,
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
}

/** A provider that gives a new refresh token each time and takes the old one back. */
function provider() {
  let issued = 0;
  let good = 'refresh-0';
  const asked: Array<{ url: string; form: URLSearchParams }> = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    asked.push({ url: String(input), form });
    if (String(input) === CONFIG.revokeUrl) return new Response('');
    if (form.get('refresh_token') !== good) {
      return new Response('{}', { status: 400 });
    }
    good = `refresh-${++issued}`;
    return Response.json({
      access_token: `access-${issued}`,
      refresh_token: good,
      expires_in: 3600,
    });
  }) as typeof fetch;
  return { fetcher, asked };
}

function make(
  options: {
    tab?: ReturnType<typeof storage>;
    kept?: ReturnType<typeof storage>;
    now?: () => number;
    fetch?: typeof fetch;
  } = {},
) {
  const tab = options.tab ?? storage();
  const went: string[] = [];
  const session = new Session(CONFIG, {
    fetch: options.fetch ?? provider().fetcher,
    storage: tab,
    ...(options.kept ? { kept: options.kept } : {}),
    navigate: (url) => void went.push(url),
    now: options.now ?? (() => 1_000_000),
    baseUrl: 'https://mail.example.com/mail/',
    storageKey: 'test',
  });
  return { session, tab, went };
}

const lapsed = (refreshToken: string) =>
  JSON.stringify({ accessToken: 'old', refreshToken, expiresAt: 0 });

describe('Session', () => {
  afterEach(() => vi.useRealTimers());

  it('picks up, in a new window, what was kept beyond the tab', async () => {
    vi.useFakeTimers();
    const kept = storage();
    kept.setItem(KEY, lapsed('refresh-0'));
    const { fetcher } = provider();
    // Nothing in the tab's own storage: the application was closed and opened again.
    const { session, tab } = make({ kept, fetch: fetcher });
    expect(session.isSignedIn).toBe(false);

    await session.restore();
    expect(session.accessToken()).toBe('access-1');
    // The new refresh token replaces the old one where it is kept, and nowhere else.
    expect(kept.getItem(KEY)).toContain('refresh-1');
    expect(tab.getItem(KEY)).toBeNull();
    session.forget();
  });

  it('keeps tokens in the tab alone when nowhere else is named', async () => {
    vi.useFakeTimers();
    const tab = storage();
    tab.setItem(KEY, lapsed('refresh-0'));
    const { session } = make({ tab });
    await session.restore();
    expect(tab.getItem(KEY)).toContain('refresh-1');
    session.forget();
    expect(tab.getItem(KEY)).toBeNull();
  });

  it('uses what another window renewed when its own refresh token was taken back', async () => {
    vi.useFakeTimers();
    const kept = storage();
    kept.setItem(KEY, lapsed('refresh-0'));
    const { fetcher } = provider();
    const first = make({ kept, fetch: fetcher });
    const second = make({ kept, fetch: fetcher });

    await first.session.restore();
    // The second still holds the token the first one used up.
    await second.session.restore();
    expect(second.session.accessToken()).toBe('access-1');
    first.session.forget();
    second.session.forget();
  });

  it('is signed out when what was kept can no longer be renewed', async () => {
    const kept = storage();
    kept.setItem(KEY, lapsed('long-gone'));
    const { session } = make({ kept });
    await session.restore();
    expect(session.isSignedIn).toBe(false);
    expect(kept.getItem(KEY)).toBeNull();
  });

  it('takes the refresh token back at the provider on signing out', async () => {
    vi.useFakeTimers();
    const kept = storage();
    kept.setItem(KEY, lapsed('refresh-0'));
    const { fetcher, asked } = provider();
    const { session, went } = make({ kept, fetch: fetcher });
    await session.restore();

    session.signOut();
    const revoked = asked.find((each) => each.url === CONFIG.revokeUrl);
    expect(revoked?.form.get('token')).toBe('refresh-1');
    expect(revoked?.form.get('client_id')).toBe('client');
    expect(kept.getItem(KEY)).toBeNull();
    expect(went[0]).toContain('https://auth.example.com/logout');
  });
});
