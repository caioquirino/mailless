import { createAdminApi } from '@mailless/admin-api';
import { InMemoryDirectory } from '@mailless/directory';
import {
  InMemoryIdentityProvider,
  TokenRefusedError,
} from '@mailless/identity';
import { createAppPasswordStore } from '@mailless/app-passwords';
import { InMemoryMetadataStore } from '@mailless/jmap-engine/memory';
import { Hono } from 'hono';
import {
  addAddress,
  createAccount,
  createAdminClient,
  createMyAppPassword,
  getAccount,
  getMe,
  listAccounts,
  setShare,
  updateAccount,
} from './index.js';

const ROLE = 'MAILLESS_ADMIN';
const PASSWORD = 'correct horse battery staple';

/** The real API in memory, reached through the generated client as a browser would reach it. */
async function setup() {
  const directory = new InMemoryDirectory();
  const identity = new InMemoryIdentityProvider({ roles: [ROLE] });
  const api = new Hono().route(
    '/admin/api',
    createAdminApi({
      directory,
      identity,
      appPasswords: createAppPasswordStore(new InMemoryMetadataStore()),
      adminRole: ROLE,
      verifyToken: async (token) => {
        const user = identity.whoIs(token);
        if (!user) throw new TokenRefusedError('refused');
        return { ...user, scopes: [], claims: {} };
      },
    }),
  );
  for (const [id, admin] of [
    ['root', true],
    ['ann', false],
  ] as const) {
    await directory.createAccount({ id });
    await identity.createUser(id);
    await identity.setPassword(id, PASSWORD);
    if (admin) await identity.grantRole(id, ROLE);
  }
  const clientFor = (username: string | null) =>
    createAdminClient({
      baseUrl: 'https://mail.example.com/admin/api',
      token: () => (username ? identity.signIn(username, PASSWORD) : undefined),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        api.request(input as Request, init)) as typeof fetch,
    });
  return { directory, identity, clientFor };
}

describe('the generated client, against the API it was generated from', () => {
  it('reads and changes accounts, with the types of the API', async () => {
    const { directory, clientFor } = await setup();
    const client = clientFor('root');

    const me = await getMe({ client });
    expect(me.response?.status).toBe(200);
    expect(me.data).toMatchObject({ username: 'root', isAdmin: true });

    const created = await createAccount({
      client,
      body: { id: 'bob', name: 'Bob B' },
    });
    expect(created.data?.status).toBe('active');
    await addAddress({
      client,
      // A path parameter is escaped for us, "@" and all.
      path: { id: 'bob', address: 'bob+news@example.com' },
    });
    await setShare({
      client,
      path: { id: 'bob', user: 'ann' },
      body: { access: 'reader' },
    });
    const renamed = await updateAccount({
      client,
      path: { id: 'bob' },
      body: { name: null },
    });
    expect(renamed.data).toMatchObject({ name: null });

    expect((await getAccount({ client, path: { id: 'bob' } })).data).toEqual({
      id: 'bob',
      name: null,
      status: 'active',
      quotaOctets: null,
      createdAt: expect.any(String),
      addresses: ['bob+news@example.com'],
      shares: { ann: 'reader' },
      sharedWith: {},
      canSignIn: true,
      isAdmin: false,
      usage: { usedOctets: null, limitOctets: null },
    });
    expect(await directory.resolveAddress('bob+news@example.com')).toBe('bob');
    expect(
      (await listAccounts({ client })).data?.map((account) => account.id),
    ).toEqual(['ann', 'bob', 'root']);
  });

  it('hands back the API’s refusals as data, by the word a program can act on', async () => {
    const { clientFor } = await setup();

    const taken = await createAccount({
      client: clientFor('root'),
      body: { id: 'ann' },
    });
    expect(taken.response?.status).toBe(409);
    expect(taken.data).toBeUndefined();
    expect(taken.error).toMatchObject({ error: 'exists' });

    const notAdmin = await listAccounts({ client: clientFor('ann') });
    expect(notAdmin.error).toMatchObject({ error: 'forbidden' });
    const signedOut = await getMe({ client: clientFor(null) });
    expect(signedOut.response?.status).toBe(401);

    // What a user does for themself needs no role.
    const made = await createMyAppPassword({
      client: clientFor('ann'),
      body: { label: 'Phone' },
    });
    expect(made.data?.secret).toMatch(/^mlapp-/);
  });
});
