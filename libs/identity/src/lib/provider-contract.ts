import { beforeEach, describe, expect, it } from 'vitest';
import {
  IdentityError,
  type IdentityErrorCode,
  type IdentityProvider,
} from './provider.js';

/**
 * A provider to test, with the role `admin` existing, and stand-ins for what
 * happens on the provider's own pages.
 */
export interface IdentityUnderTest {
  provider: IdentityProvider;
  /** An access token for a user who signs in with this password, or undefined when refused. */
  signIn(username: string, password: string): Promise<string | undefined>;
  /** A signed-in user adds a passkey, and its id is returned. */
  enrolPasskey(accessToken: string, name: string): Promise<string>;
}

async function refusal(
  action: () => Promise<unknown>,
): Promise<IdentityErrorCode | 'no error'> {
  try {
    await action();
    return 'no error';
  } catch (error) {
    if (error instanceof IdentityError) return error.code;
    throw error;
  }
}

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'another long enough passphrase';

/** What every identity provider does, whichever it is. */
export function describeIdentityContract(
  name: string,
  factory: () => Promise<IdentityUnderTest>,
): void {
  describe(`${name}: identity provider contract`, () => {
    let under: IdentityUnderTest;
    let provider: IdentityProvider;
    beforeEach(async () => {
      under = await factory();
      provider = under.provider;
    });

    it('creates users who cannot sign in until they have a password', async () => {
      expect(await provider.createUser('ann')).toEqual({
        username: 'ann',
        enabled: true,
        roles: [],
        createdAt: expect.any(String),
      });
      expect(await provider.getUser('ann')).toMatchObject({ username: 'ann' });
      expect(await provider.getUser('nobody')).toBeUndefined();
      expect(await refusal(() => provider.createUser('ann'))).toBe('exists');
      expect(await under.signIn('ann', PASSWORD)).toBeUndefined();

      await provider.setPassword('ann', PASSWORD);
      expect(await under.signIn('ann', PASSWORD)).toEqual(expect.any(String));
      expect(
        await under.signIn('ann', 'not the password at all'),
      ).toBeUndefined();
      expect(await refusal(() => provider.setPassword('ann', 'short'))).toBe(
        'invalidPassword',
      );
      expect(
        await refusal(() => provider.setPassword('nobody', PASSWORD)),
      ).toBe('notFound');

      await provider.createUser('bob');
      expect((await provider.listUsers()).map((user) => user.username)).toEqual(
        ['ann', 'bob'],
      );
    });

    it('disables, enables and deletes users', async () => {
      await provider.createUser('ann');
      await provider.setPassword('ann', PASSWORD);
      const token = (await under.signIn('ann', PASSWORD)) as string;

      await provider.setEnabled('ann', false);
      expect(await provider.getUser('ann')).toMatchObject({ enabled: false });
      expect(await under.signIn('ann', PASSWORD)).toBeUndefined();
      // What they were signed in with is of no more use to them either.
      expect(await refusal(() => provider.listOwnPasskeys(token))).toBe(
        'notAuthorized',
      );

      await provider.setEnabled('ann', true);
      expect(await under.signIn('ann', PASSWORD)).toEqual(expect.any(String));

      await provider.deleteUser('ann');
      expect(await provider.getUser('ann')).toBeUndefined();
      expect(await under.signIn('ann', PASSWORD)).toBeUndefined();
      for (const action of [
        () => provider.deleteUser('ann'),
        () => provider.setEnabled('ann', true),
        () => provider.signOutEverywhere('ann'),
      ]) {
        expect(await refusal(action)).toBe('notFound');
      }
    });

    it('grants and revokes roles that exist', async () => {
      await provider.createUser('ann');
      await provider.grantRole('ann', 'admin');
      await provider.grantRole('ann', 'admin');
      expect((await provider.getUser('ann'))?.roles).toEqual(['admin']);
      expect(
        (await provider.listUsers()).find((user) => user.username === 'ann')
          ?.roles,
      ).toEqual(['admin']);

      expect(await refusal(() => provider.grantRole('ann', 'emperor'))).toBe(
        'notFound',
      );
      expect(await refusal(() => provider.grantRole('nobody', 'admin'))).toBe(
        'notFound',
      );

      await provider.revokeRole('ann', 'admin');
      // Revoking what is not held is not an error: the outcome is the one asked for.
      await provider.revokeRole('ann', 'admin');
      expect((await provider.getUser('ann'))?.roles).toEqual([]);
    });

    it('lets a signed-in user change their own password', async () => {
      await provider.createUser('ann');
      await provider.setPassword('ann', PASSWORD);
      const token = (await under.signIn('ann', PASSWORD)) as string;

      expect(
        await refusal(() =>
          provider.changeOwnPassword(token, 'not the password', OTHER_PASSWORD),
        ),
      ).toBe('notAuthorized');
      expect(
        await refusal(() =>
          provider.changeOwnPassword(token, PASSWORD, 'short'),
        ),
      ).toBe('invalidPassword');
      expect(
        await refusal(() =>
          provider.changeOwnPassword('not a token', PASSWORD, OTHER_PASSWORD),
        ),
      ).toBe('notAuthorized');
      expect(await under.signIn('ann', PASSWORD)).toEqual(expect.any(String));

      await provider.changeOwnPassword(token, PASSWORD, OTHER_PASSWORD);
      expect(await under.signIn('ann', PASSWORD)).toBeUndefined();
      expect(await under.signIn('ann', OTHER_PASSWORD)).toEqual(
        expect.any(String),
      );
    });

    it('lists and removes the passkeys of the user who asks, and of nobody else', async () => {
      for (const user of ['ann', 'bob']) {
        await provider.createUser(user);
        await provider.setPassword(user, PASSWORD);
      }
      const ann = (await under.signIn('ann', PASSWORD)) as string;
      const bob = (await under.signIn('bob', PASSWORD)) as string;
      expect(await provider.listOwnPasskeys(ann)).toEqual([]);

      const phone = await under.enrolPasskey(ann, 'Phone');
      const laptop = await under.enrolPasskey(ann, 'Laptop');
      const bobs = await under.enrolPasskey(bob, 'Key');
      expect(await provider.listOwnPasskeys(ann)).toEqual([
        { id: phone, name: 'Phone', createdAt: expect.any(String) },
        { id: laptop, name: 'Laptop', createdAt: expect.any(String) },
      ]);

      // A passkey can only be removed with the token of whose it is.
      expect(await refusal(() => provider.removeOwnPasskey(ann, bobs))).toBe(
        'notFound',
      );
      await provider.removeOwnPasskey(ann, phone);
      expect(
        (await provider.listOwnPasskeys(ann)).map((passkey) => passkey.id),
      ).toEqual([laptop]);
      expect(await refusal(() => provider.removeOwnPasskey(ann, phone))).toBe(
        'notFound',
      );
      expect(await provider.listOwnPasskeys(bob)).toHaveLength(1);
    });

    it('ends every session of a user when asked', async () => {
      await provider.createUser('ann');
      await provider.setPassword('ann', PASSWORD);
      const token = (await under.signIn('ann', PASSWORD)) as string;
      await provider.signOutEverywhere('ann');
      expect(await refusal(() => provider.listOwnPasskeys(token))).toBe(
        'notAuthorized',
      );
      // They may sign in again: their password is still theirs.
      expect(await under.signIn('ann', PASSWORD)).toEqual(expect.any(String));
    });
  });
}
