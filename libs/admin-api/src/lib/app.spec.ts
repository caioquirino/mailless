import { readFileSync } from 'node:fs';
import { InMemoryDirectory } from '@mailless/directory';
import {
  InMemoryIdentityProvider,
  TokenRefusedError,
} from '@mailless/identity';
import { createAppPasswordStore } from '@mailless/jmap-server/auth';
import { InMemoryMetadataStore } from '@mailless/jmap-server/memory';
import { adminApiDocument, createAdminApi, type AuditEntry } from './app.js';

const ROLE = 'MAILLESS_ADMIN';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'another long enough passphrase';
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup() {
  const directory = new InMemoryDirectory();
  const identity = new InMemoryIdentityProvider({ roles: [ROLE] });
  const appPasswords = createAppPasswordStore(new InMemoryMetadataStore());
  const audit: AuditEntry[] = [];
  const errors: unknown[] = [];
  const api = createAdminApi({
    directory,
    identity,
    appPasswords,
    adminRole: ROLE,
    passkeyEnrolmentUrl: 'https://auth.example.com/passkeys/add',
    // A token is whatever the in-memory provider handed out at sign-in.
    verifyToken: async (token) => {
      const user = identity.whoIs(token);
      if (!user) throw new TokenRefusedError('refused');
      return {
        username: user.username,
        roles: user.roles,
        scopes: [],
        claims: {},
      };
    },
    audit: (entry) => audit.push(entry),
    onError: (error) => errors.push(error),
  });
  /** A user with a mailbox who has signed in. */
  const person = async (id: string, admin = false) => {
    await directory.createAccount({ id });
    await identity.createUser(id);
    await identity.setPassword(id, PASSWORD);
    if (admin) await identity.grantRole(id, ROLE);
    return signIn(id);
  };
  const signIn = (id: string, password = PASSWORD) => {
    const token = identity.signIn(id, password);
    if (!token) throw new Error(`${id} could not sign in`);
    return token;
  };

  const call = async (
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> => {
    const response = await api.request(path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return {
    api,
    directory,
    identity,
    appPasswords,
    audit,
    errors,
    person,
    signIn,
    call,
  };
}

describe('admin API', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let admin: string;
  let ann: string;
  beforeEach(async () => {
    t = await setup();
    admin = await t.person('root', true);
    ann = await t.person('ann');
  });

  describe('who may call it', () => {
    it('needs a token the identity provider stands behind', async () => {
      for (const token of [null, 'nonsense', 'memory-token-999']) {
        const { status, body } = await t.call(token, 'GET', '/me');
        expect([status, body.error]).toEqual([401, 'unauthorized']);
      }
      const basic = await t.api.request('/me', {
        headers: { authorization: 'Basic cm9vdDpwYXNz' },
      });
      expect(basic.status).toBe(401);
      expect((await t.call(ann, 'GET', '/me')).status).toBe(200);
    });

    it('keeps everything under /accounts for administrators', async () => {
      for (const [method, path, body] of [
        ['GET', '/accounts'],
        ['POST', '/accounts', { id: 'eve' }],
        ['GET', '/accounts/root'],
        ['PATCH', '/accounts/root', { status: 'disabled' }],
        ['DELETE', '/accounts/root'],
        ['POST', '/accounts/ann/password', { password: NEW_PASSWORD }],
        ['POST', '/accounts/root/sign-out'],
        ['PUT', '/accounts/ann/admin'],
        ['DELETE', '/accounts/root/admin'],
        ['PUT', '/accounts/ann/addresses/x@example.com'],
        ['PUT', '/accounts/root/shares/ann', { access: 'member' }],
        ['GET', '/accounts/root/app-passwords'],
        ['DELETE', '/accounts/root/app-passwords/x'],
      ] as Array<[string, string, unknown?]>) {
        const { status, body: answer } = await t.call(ann, method, path, body);
        expect([status, answer.error], `${method} ${path}`).toEqual([
          403,
          'forbidden',
        ]);
      }
      // Nothing came of any of it.
      expect(await t.directory.account('eve')).toBeUndefined();
      expect((await t.identity.getUser('ann'))?.roles).toEqual([]);
      expect(t.audit).toEqual([]);
      expect((await t.call(admin, 'GET', '/accounts')).status).toBe(200);
    });

    it('answers what it does not have, and what it cannot read, as such', async () => {
      expect((await t.call(admin, 'GET', '/elsewhere')).body.error).toBe(
        'notFound',
      );
      const unread = await t.api.request('/accounts', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin}`,
          'content-type': 'application/json',
        },
        body: '{not json',
      });
      expect(unread.status).toBe(400);
      expect(t.errors).toEqual([]);
    });
  });

  describe('/me', () => {
    it('says who is signed in and what they can do here', async () => {
      await t.directory.addAddress('ann', 'ann@example.com');
      expect((await t.call(ann, 'GET', '/me')).body).toEqual({
        username: 'ann',
        isAdmin: false,
        account: {
          id: 'ann',
          name: null,
          status: 'active',
          createdAt: expect.any(String),
        },
        addresses: ['ann@example.com'],
        capabilities: {
          changeOwnPassword: true,
          manageOwnPasskeys: true,
          removePasskeysOfOthers: false,
        },
        passkeyEnrolmentUrl: 'https://auth.example.com/passkeys/add',
      });
      expect((await t.call(admin, 'GET', '/me')).body.isAdmin).toBe(true);
    });

    it('changes the caller’s own password, given the current one', async () => {
      const change = (currentPassword: string, newPassword: string) =>
        t.call(ann, 'POST', '/me/password', { currentPassword, newPassword });
      expect((await change('not it', NEW_PASSWORD)).body.error).toBe(
        'notAuthorized',
      );
      const weak = await change(PASSWORD, 'short');
      expect([weak.status, weak.body.error]).toEqual([422, 'invalidPassword']);
      expect((await t.call(ann, 'POST', '/me/password', {})).status).toBe(400);

      expect((await change(PASSWORD, NEW_PASSWORD)).status).toBe(204);
      expect(t.identity.signIn('ann', PASSWORD)).toBeUndefined();
      expect(t.identity.signIn('ann', NEW_PASSWORD)).toEqual(
        expect.any(String),
      );
      // The record says that it happened, and nothing of what the passwords were.
      expect(t.audit).toEqual([
        { actor: 'ann', action: 'changeMyPassword', account: 'ann' },
      ]);
      expect(JSON.stringify(t.audit)).not.toContain('passphrase');
    });

    it('lists and removes the caller’s own passkeys', async () => {
      const phone = t.identity.enrolPasskey(ann, 'Phone');
      const others = t.identity.enrolPasskey(admin, 'Key');
      expect((await t.call(ann, 'GET', '/me/passkeys')).body).toEqual([
        { id: phone.id, name: 'Phone', createdAt: expect.any(String) },
      ]);
      // Somebody else's passkey is not there to remove.
      expect(
        (await t.call(ann, 'DELETE', `/me/passkeys/${others.id}`)).status,
      ).toBe(404);
      expect(
        (await t.call(ann, 'DELETE', `/me/passkeys/${phone.id}`)).status,
      ).toBe(204);
      expect((await t.call(ann, 'GET', '/me/passkeys')).body).toEqual([]);
      expect((await t.call(admin, 'GET', '/me/passkeys')).body).toHaveLength(1);
    });

    it('makes app passwords for the caller’s own mailbox, shown once', async () => {
      const made = await t.call(ann, 'POST', '/me/app-passwords', {
        label: 'Phone',
      });
      expect(made.status).toBe(201);
      expect(made.body.secret).toMatch(/^mlapp-/);
      const listed = (await t.call(ann, 'GET', '/me/app-passwords')).body;
      expect(listed).toEqual([
        {
          id: made.body.id,
          label: 'Phone',
          createdAt: expect.any(String),
          lastUsedAt: null,
        },
      ]);
      expect(JSON.stringify(t.audit)).not.toContain('mlapp-');
      // It opens her mailbox, as a mail app would use it.
      expect(
        (await t.appPasswords.verify('ann', made.body.secret))?.label,
      ).toBe('Phone');

      // One user's password is not another's to see or revoke.
      expect((await t.call(admin, 'GET', '/me/app-passwords')).body).toEqual(
        [],
      );
      expect(
        (await t.call(admin, 'DELETE', `/me/app-passwords/${made.body.id}`))
          .status,
      ).toBe(404);
      expect(
        (await t.call(ann, 'DELETE', `/me/app-passwords/${made.body.id}`))
          .status,
      ).toBe(204);
      expect(await t.appPasswords.verify('ann', made.body.secret)).toBeNull();
      expect(
        (await t.call(ann, 'POST', '/me/app-passwords', { label: '' })).status,
      ).toBe(400);
    });

    it('gives no app passwords to a user without a mailbox in use', async () => {
      await t.identity.createUser('guest');
      await t.identity.setPassword('guest', PASSWORD);
      const guest = t.signIn('guest');
      expect((await t.call(guest, 'GET', '/me')).body).toMatchObject({
        username: 'guest',
        account: null,
        addresses: [],
      });
      const refused = await t.call(guest, 'POST', '/me/app-passwords', {
        label: 'Phone',
      });
      expect([refused.status, refused.body.error]).toEqual([403, 'forbidden']);
      expect((await t.call(guest, 'GET', '/me/app-passwords')).status).toBe(
        403,
      );
    });
  });

  describe('/accounts', () => {
    it('makes an account with a user who cannot sign in until given a password', async () => {
      const made = await t.call(admin, 'POST', '/accounts', {
        id: 'bob',
        name: 'Bob B',
      });
      expect(made.status).toBe(201);
      expect(made.body).toEqual({
        id: 'bob',
        name: 'Bob B',
        status: 'active',
        createdAt: expect.any(String),
        addresses: [],
        shares: {},
        sharedWith: {},
        canSignIn: true,
        isAdmin: false,
      });
      expect(t.identity.signIn('bob', PASSWORD)).toBeUndefined();

      const weak = await t.call(admin, 'POST', '/accounts/bob/password', {
        password: 'short',
      });
      expect(weak.status).toBe(422);
      expect(
        (
          await t.call(admin, 'POST', '/accounts/bob/password', {
            password: PASSWORD,
          })
        ).status,
      ).toBe(204);
      expect(t.identity.signIn('bob', PASSWORD)).toEqual(expect.any(String));

      expect(
        (await t.call(admin, 'GET', '/accounts')).body.map((a: Json) => a.id),
      ).toEqual(['ann', 'bob', 'root']);
      const again = await t.call(admin, 'POST', '/accounts', { id: 'bob' });
      expect([again.status, again.body.error]).toEqual([409, 'exists']);
      for (const id of ['Bob', 'a b', '', 'x'.repeat(65)]) {
        expect((await t.call(admin, 'POST', '/accounts', { id })).status).toBe(
          400,
        );
      }
      expect(t.audit.map((entry) => entry.action)).toEqual([
        'createAccount',
        'setAccountPassword',
      ]);
    });

    it('takes on a user the identity provider already has, and undoes an account it cannot give a user', async () => {
      await t.identity.createUser('old');
      expect(
        (await t.call(admin, 'POST', '/accounts', { id: 'old' })).status,
      ).toBe(201);

      vi.spyOn(t.identity, 'createUser').mockRejectedValueOnce(
        new Error('the provider is unreachable'),
      );
      const failed = await t.call(admin, 'POST', '/accounts', { id: 'new' });
      expect(failed.status).toBe(500);
      expect(failed.body.message).not.toContain('unreachable');
      expect(t.errors).toHaveLength(1);
      // No account is left without a user to go with it.
      expect(await t.directory.account('new')).toBeUndefined();
    });

    it('renames an account and switches it off and on', async () => {
      const renamed = await t.call(admin, 'PATCH', '/accounts/ann', {
        name: 'Ann A',
      });
      expect(renamed.body).toMatchObject({ name: 'Ann A', status: 'active' });

      const off = await t.call(admin, 'PATCH', '/accounts/ann', {
        status: 'disabled',
      });
      expect(off.body).toMatchObject({
        name: 'Ann A',
        status: 'disabled',
        canSignIn: false,
      });
      expect(t.identity.signIn('ann', PASSWORD)).toBeUndefined();
      // What she was signed in with is of no more use either.
      expect((await t.call(ann, 'GET', '/me')).status).toBe(401);

      const on = await t.call(admin, 'PATCH', '/accounts/ann', {
        status: 'active',
        name: null,
      });
      expect(on.body).toMatchObject({
        name: null,
        status: 'active',
        canSignIn: true,
      });
      expect(t.identity.signIn('ann', PASSWORD)).toEqual(expect.any(String));
      expect(t.audit.map((entry) => entry.action)).toEqual([
        'renameAccount',
        'disableAccount',
        'enableAccount',
        'renameAccount',
      ]);

      expect(
        (await t.call(admin, 'PATCH', '/accounts/nobody', {})).status,
      ).toBe(404);
      expect(
        (await t.call(admin, 'PATCH', '/accounts/ann', { status: 'deleting' }))
          .status,
      ).toBe(400);
    });

    it('does not let administrators lock themselves out', async () => {
      for (const [method, path, body] of [
        ['PATCH', '/accounts/root', { status: 'disabled' }],
        ['DELETE', '/accounts/root'],
        ['DELETE', '/accounts/root/admin'],
      ] as Array<[string, string, unknown?]>) {
        const { status, body: answer } = await t.call(
          admin,
          method,
          path,
          body,
        );
        expect([status, answer.error], `${method} ${path}`).toEqual([
          403,
          'forbidden',
        ]);
      }
      expect(await t.identity.getUser('root')).toMatchObject({
        enabled: true,
        roles: [ROLE],
      });
      // Another administrator can.
      await t.call(admin, 'PUT', '/accounts/ann/admin');
      const second = t.signIn('ann');
      expect(
        (await t.call(second, 'DELETE', '/accounts/root/admin')).status,
      ).toBe(204);
      expect((await t.identity.getUser('root'))?.roles).toEqual([]);
      // The role was in the token the first one held, so that token is ended.
      expect((await t.call(admin, 'GET', '/accounts')).status).toBe(401);
    });

    it('grants the administrator role, which counts from the next sign-in', async () => {
      expect((await t.call(admin, 'PUT', '/accounts/ann/admin')).status).toBe(
        204,
      );
      expect((await t.call(admin, 'GET', '/accounts/ann')).body.isAdmin).toBe(
        true,
      );
      expect(
        (await t.call(admin, 'PUT', '/accounts/nobody/admin')).status,
      ).toBe(404);
    });

    it('delivers addresses to accounts', async () => {
      const put = (id: string, address: string) =>
        t.call(
          admin,
          'PUT',
          `/accounts/${id}/addresses/${encodeURIComponent(address)}`,
        );
      expect((await put('ann', 'Ann@Example.com')).status).toBe(204);
      expect((await put('ann', '*@example.org')).status).toBe(204);
      expect(
        (await t.call(admin, 'GET', '/accounts/ann')).body.addresses,
      ).toEqual(['*@example.org', 'ann@example.com']);
      expect(await t.directory.resolveAddress('x@example.org')).toBe('ann');

      const taken = await put('root', 'ann@example.com');
      expect([taken.status, taken.body.error]).toEqual([409, 'addressTaken']);
      expect((await put('ann', 'nonsense')).status).toBe(400);
      expect((await put('nobody', 'n@example.com')).status).toBe(404);

      const remove = (id: string, address: string) =>
        t.call(
          admin,
          'DELETE',
          `/accounts/${id}/addresses/${encodeURIComponent(address)}`,
        );
      expect((await remove('root', 'ann@example.com')).status).toBe(404);
      expect((await remove('ann', 'ann@example.com')).status).toBe(204);
      expect(
        await t.directory.resolveAddress('ann@example.com'),
      ).toBeUndefined();
      // The record names the account, never the address.
      expect(JSON.stringify(t.audit)).not.toContain('@');
    });

    it('shares accounts with other users', async () => {
      await t.directory.createAccount({ id: 'team' });
      const share = (access: string) =>
        t.call(admin, 'PUT', '/accounts/team/shares/ann', { access });
      expect((await share('reader')).status).toBe(204);
      expect((await share('member')).status).toBe(204);
      expect(
        (await t.call(admin, 'GET', '/accounts/team')).body.shares,
      ).toEqual({ ann: 'member' });
      expect(
        (await t.call(admin, 'GET', '/accounts/ann')).body.sharedWith,
      ).toEqual({ team: 'member' });

      expect((await share('owner')).status).toBe(400);
      expect(
        (
          await t.call(admin, 'PUT', '/accounts/team/shares/team', {
            access: 'member',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await t.call(admin, 'PUT', '/accounts/team/shares/nobody', {
            access: 'reader',
          })
        ).status,
      ).toBe(404);
      expect(
        (await t.call(admin, 'DELETE', '/accounts/team/shares/ann')).status,
      ).toBe(204);
      expect(
        (await t.call(admin, 'DELETE', '/accounts/team/shares/ann')).status,
      ).toBe(404);
    });

    it('lets an administrator see and revoke a user’s app passwords, but not make them', async () => {
      const { id, secret } = await t.appPasswords.create('ann', 'Lost phone');
      const listed = await t.call(admin, 'GET', '/accounts/ann/app-passwords');
      expect(listed.body).toMatchObject([{ id, label: 'Lost phone' }]);
      expect(JSON.stringify(listed.body)).not.toContain('mlapp-');
      expect(
        (
          await t.call(admin, 'POST', '/accounts/ann/app-passwords', {
            label: 'x',
          })
        ).status,
      ).toBe(404);
      expect(
        (await t.call(admin, 'DELETE', `/accounts/ann/app-passwords/${id}`))
          .status,
      ).toBe(204);
      expect(await t.appPasswords.verify('ann', secret)).toBeNull();
      expect(
        (await t.call(admin, 'DELETE', `/accounts/ann/app-passwords/${id}`))
          .status,
      ).toBe(404);
    });

    it('ends every session of a user when asked', async () => {
      expect(
        (await t.call(admin, 'POST', '/accounts/ann/sign-out')).status,
      ).toBe(204);
      expect((await t.call(ann, 'GET', '/me')).status).toBe(401);
      expect(t.identity.signIn('ann', PASSWORD)).toEqual(expect.any(String));
    });

    it('closes an account for good, and keeps its id from being used again', async () => {
      await t.directory.createAccount({ id: 'team' });
      await t.directory.addAddress('ann', 'ann@example.com');
      await t.directory.setShare('team', 'ann', 'member');
      await t.directory.setShare('ann', 'root', 'reader');
      const { secret } = await t.appPasswords.create('ann', 'Phone');

      expect((await t.call(admin, 'DELETE', '/accounts/ann')).status).toBe(204);
      expect(await t.identity.getUser('ann')).toBeUndefined();
      expect((await t.call(ann, 'GET', '/me')).status).toBe(401);
      expect(await t.appPasswords.verify('ann', secret)).toBeNull();
      expect(
        await t.directory.resolveAddress('ann@example.com'),
      ).toBeUndefined();
      expect(await t.directory.sharesOf('team')).toEqual({});
      expect(await t.directory.sharedWith('root')).toEqual({});

      // It stays, marked, so that nobody new is given its id while its mail exists.
      expect((await t.call(admin, 'GET', '/accounts/ann')).body).toMatchObject({
        status: 'deleting',
        addresses: [],
        canSignIn: false,
      });
      const reuse = await t.call(admin, 'POST', '/accounts', { id: 'ann' });
      expect([reuse.status, reuse.body.error]).toEqual([409, 'exists']);
      for (const [method, path, body] of [
        ['PATCH', '/accounts/ann', { status: 'active' }],
        ['POST', '/accounts/ann/password', { password: PASSWORD }],
        ['PUT', '/accounts/ann/admin'],
        ['PUT', '/accounts/ann/addresses/ann@example.com'],
        ['PUT', '/accounts/ann/shares/root', { access: 'reader' }],
      ] as Array<[string, string, unknown?]>) {
        expect(
          (await t.call(admin, method, path, body)).status,
          `${method} ${path}`,
        ).toBe(403);
      }
      // Deleting it again changes nothing and fails nothing.
      expect((await t.call(admin, 'DELETE', '/accounts/ann')).status).toBe(204);
      expect((await t.call(admin, 'DELETE', '/accounts/nobody')).status).toBe(
        404,
      );
    });
  });

  describe('the OpenAPI document', () => {
    it('is the one committed next to the code', () => {
      const committed = JSON.parse(
        readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'),
      );
      // Out of date? Run `pnpm nx run admin-api:openapi` and commit the result.
      expect(adminApiDocument()).toEqual(committed);
    });

    it('describes every operation by name, with what it takes and answers', () => {
      const document = adminApiDocument() as Json;
      expect(document.openapi).toBe('3.1.0');
      expect(document.servers).toEqual([{ url: '/admin/api' }]);
      const operations = Object.values(document.paths).flatMap((path: Json) =>
        Object.values(path),
      ) as Json[];
      expect(operations.length).toBeGreaterThan(20);
      const ids = operations.map((operation) => operation.operationId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const operation of operations) {
        expect(operation.operationId, JSON.stringify(operation)).toEqual(
          expect.any(String),
        );
        expect(operation.security).toEqual([{ bearer: [] }]);
        expect(Object.keys(operation.responses)).toEqual(
          expect.arrayContaining(['401', '403']),
        );
      }
      expect(
        document.paths['/accounts/{id}/addresses/{address}'].put.parameters.map(
          (parameter: Json) => [
            parameter.name,
            parameter.in,
            parameter.required,
          ],
        ),
      ).toEqual([
        ['id', 'path', true],
        ['address', 'path', true],
      ]);
      // A named type is what it says wherever it is used: none is "this, or nothing".
      for (const [name, schema] of Object.entries(
        document.components.schemas as Record<string, Json>,
      )) {
        expect(schema.type, name).not.toEqual(expect.arrayContaining(['null']));
      }
      expect(Object.keys(document.components.schemas)).toEqual(
        expect.arrayContaining(['Account', 'AccountDetail', 'Me', 'Error']),
      );
    });
  });
});
