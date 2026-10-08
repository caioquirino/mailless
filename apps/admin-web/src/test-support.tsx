import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type {
  AccountDetail,
  AppPassword,
  Me,
  Passkey,
} from '@mailless/admin-client';
import { App } from './app/app';
import { ServicesProvider } from './app/services';
import { createApi } from './lib/api';
import type { AppConfig } from './lib/config';
import { Session } from './lib/session';

export const CONFIG: AppConfig = {
  apiBaseUrl: '/admin/api',
  clientId: 'admin-client',
  authorizeUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  logoutUrl: 'https://auth.example.com/logout',
  scopes: ['openid', 'aws.cognito.signin.user.admin'],
  passkeyEnrolmentUrl: 'https://auth.example.com/passkeys/add',
};
export const ORIGIN = 'https://mail.example.com';
const API = `${ORIGIN}/admin/api`;

export interface Recorded {
  method: string;
  /** The path under the API, still encoded as it was sent. */
  path: string;
  body: unknown;
  token: string | null;
}

const account = (
  id: string,
  more: Partial<AccountDetail> = {},
): AccountDetail => ({
  id,
  name: null,
  status: 'active',
  createdAt: '2026-01-02T03:04:05.000Z',
  addresses: [],
  shares: {},
  sharedWith: {},
  canSignIn: true,
  isAdmin: false,
  usage: { usedOctets: null, limitOctets: null },
  ...more,
});

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
const refusal = (status: number, error: string, message: string) =>
  json(status, { error, message });

/**
 * Stands in for the identity provider's token endpoint and for the
 * administration API, at the `fetch` boundary: the page's own code, the
 * generated client included, runs as it does in a browser.
 */
export function fakeBackend(
  options: { username?: string; isAdmin?: boolean; mailbox?: boolean } = {},
) {
  const username = options.username ?? 'ann';
  const state = {
    /** What the token endpoint hands out next; null makes it refuse. */
    nextAccessToken: 'access-1' as string | null,
    /** Access tokens the API accepts. */
    accepted: new Set(['access-1']),
    tokenRequests: [] as Array<Record<string, string>>,
    calls: [] as Recorded[],
    passkeys: [] as Passkey[],
    appPasswords: [] as AppPassword[],
    accounts: new Map<string, AccountDetail>([
      [
        username,
        account(username, {
          isAdmin: options.isAdmin ?? false,
          addresses: [`${username}@example.com`],
        }),
      ],
      ['bob', account('bob', { name: 'Bob B' })],
    ]),
  };

  const me = (): Me => {
    const own = state.accounts.get(username) as AccountDetail;
    const mailbox = options.mailbox ?? true;
    return {
      username,
      isAdmin: options.isAdmin ?? false,
      account: mailbox
        ? {
            id: own.id,
            name: own.name,
            status: own.status,
            createdAt: own.createdAt,
          }
        : null,
      addresses: mailbox ? own.addresses : [],
      usage: mailbox ? own.usage : null,
      capabilities: {
        changeOwnPassword: true,
        manageOwnPasskeys: true,
        removePasskeysOfOthers: false,
      },
      passkeyEnrolmentUrl: CONFIG.passkeyEnrolmentUrl,
    };
  };

  async function api(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const key = `${method} /${parts[0] ?? ''}${parts.length > 1 ? '/…' : ''}`;
    if (method === 'GET' && path === '/me') return json(200, me());
    if (path === '/me/password') {
      const { currentPassword, newPassword } = body as Record<string, string>;
      if (currentPassword !== 'the current password') {
        return refusal(
          403,
          'notAuthorized',
          'The current password is not right',
        );
      }
      if ((newPassword ?? '').length < 14) {
        return refusal(
          422,
          'invalidPassword',
          'A password has at least 14 characters',
        );
      }
      return json(204);
    }
    if (path === '/me/passkeys') return json(200, state.passkeys);
    if (parts[1] === 'passkeys' && method === 'DELETE') {
      state.passkeys = state.passkeys.filter((p) => p.id !== parts[2]);
      return json(204);
    }
    if (path === '/me/app-passwords' && method === 'GET') {
      return json(200, state.appPasswords);
    }
    if (path === '/me/app-passwords' && method === 'POST') {
      const created: AppPassword = {
        id: `ap${state.appPasswords.length + 1}`,
        label: (body as { label: string }).label,
        createdAt: '2026-02-03T04:05:06.000Z',
        lastUsedAt: null,
      };
      state.appPasswords.push(created);
      return json(201, { ...created, secret: 'mlapp-aaaaa-bbbbb-ccccc' });
    }
    if (parts[1] === 'app-passwords' && method === 'DELETE') {
      state.appPasswords = state.appPasswords.filter((p) => p.id !== parts[2]);
      return json(204);
    }

    if (parts[0] === 'accounts') {
      if (!(options.isAdmin ?? false)) {
        return refusal(403, 'forbidden', 'Only an administrator may do this');
      }
      if (parts.length === 1 && method === 'GET') {
        return json(
          200,
          [...state.accounts.values()].map(
            ({ id, name, status, createdAt, usage }) => ({
              id,
              name,
              status,
              createdAt,
              usage,
            }),
          ),
        );
      }
      if (parts.length === 1 && method === 'POST') {
        const input = body as { id: string; name?: string | null };
        if (state.accounts.has(input.id)) {
          return refusal(
            409,
            'exists',
            `The account "${input.id}" already exists`,
          );
        }
        const created = account(input.id, { name: input.name ?? null });
        state.accounts.set(input.id, created);
        return json(201, created);
      }
      const found = state.accounts.get(parts[1] ?? '');
      if (!found) {
        return refusal(404, 'notFound', `There is no account "${parts[1]}"`);
      }
      if (parts.length === 2 && method === 'GET') return json(200, found);
      if (parts.length === 2 && method === 'PATCH') {
        Object.assign(found, body);
        return json(200, found);
      }
      if (parts[2] === 'addresses' && method === 'PUT') {
        found.addresses = [...found.addresses, parts[3] as string].sort();
        return json(204);
      }
      if (parts[2] === 'app-passwords' && method === 'GET')
        return json(200, []);
      return json(204);
    }
    return refusal(404, 'notFound', `Nothing answers ${key}`);
  }

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === CONFIG.tokenUrl) {
      const form = Object.fromEntries(
        new URLSearchParams(await request.text()),
      );
      state.tokenRequests.push(form);
      if (state.nextAccessToken === null) {
        return json(400, { error: 'invalid_grant' });
      }
      state.accepted.add(state.nextAccessToken);
      return json(200, {
        access_token: state.nextAccessToken,
        // A renewal gives no new refresh token, as with Cognito.
        ...(form['grant_type'] === 'authorization_code'
          ? { refresh_token: 'refresh-1' }
          : {}),
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    if (!request.url.startsWith(`${API}/`)) return json(404);
    const path = new URL(request.url).pathname.slice('/admin/api'.length);
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    const token =
      /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ??
      null;
    state.calls.push({ method: request.method, path, body, token });
    if (token === null || !state.accepted.has(token)) {
      return refusal(401, 'unauthorized', 'The token is not accepted');
    }
    return api(request.method, path, body);
  }) as typeof fetch;

  return { state, fetch: fetcher };
}

export type FakeBackend = ReturnType<typeof fakeBackend>;

/** A session wired to the fake backend, with what it would have done to the browser recorded. */
export function testSession(backend: FakeBackend) {
  const visited: string[] = [];
  const session = new Session(CONFIG, {
    fetch: backend.fetch,
    storage: window.sessionStorage,
    navigate: (url) => visited.push(url),
    now: () => Date.now(),
    baseUrl: `${ORIGIN}/admin/`,
  });
  return { session, visited };
}

/** Signs in the way a person does: to the provider and back with a code. */
export async function signIn(
  session: Session,
  visited: string[],
): Promise<void> {
  await session.beginSignIn();
  const state = new URL(visited.at(-1) as string).searchParams.get('state');
  await session.completeSignIn(
    new URLSearchParams({ code: 'code-1', state: state as string }),
  );
}

/** The whole page at a path, against the fake backend. Signed in unless told otherwise. */
export async function renderApp(
  backend: FakeBackend,
  path: string,
  options: { signedIn?: boolean } = {},
): Promise<RenderResult & { session: Session; visited: string[] }> {
  const { session, visited } = testSession(backend);
  if (options.signedIn ?? true) await signIn(session, visited);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <ServicesProvider
      value={{
        config: CONFIG,
        session,
        api: createApi(session, API, backend.fetch),
      }}
    >
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </ServicesProvider>,
  );
  return { ...view, session, visited };
}
