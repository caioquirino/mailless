import { beforeEach, describe, expect, it } from 'vitest';
import {
  DirectoryError,
  type Directory,
  type DirectoryErrorCode,
} from './directory.js';

/** Makes an empty directory. */
export type DirectoryFactory = () => Promise<Directory>;

async function refusal(
  action: () => Promise<unknown>,
): Promise<DirectoryErrorCode | 'no error'> {
  try {
    await action();
    return 'no error';
  } catch (error) {
    if (error instanceof DirectoryError) return error.code;
    throw error;
  }
}

/**
 * What every directory does, whatever keeps it. Run it against each
 * implementation.
 */
export function describeDirectoryContract(
  name: string,
  factory: DirectoryFactory,
): void {
  describe(`${name}: directory contract`, () => {
    let directory: Directory;
    beforeEach(async () => {
      directory = await factory();
    });

    it('creates, lists, changes and deletes accounts', async () => {
      const ann = await directory.createAccount({ id: 'ann', name: ' Ann A ' });
      expect(ann).toEqual({
        id: 'ann',
        name: 'Ann A',
        status: 'active',
        createdAt: expect.stringMatching(/^\d{4}-.*Z$/),
      });
      await directory.createAccount({ id: 'bob' });
      expect(await directory.account('bob')).toMatchObject({
        id: 'bob',
        name: null,
      });
      expect(await directory.account('nobody')).toBeUndefined();
      expect((await directory.listAccounts()).map(({ id }) => id)).toEqual([
        'ann',
        'bob',
      ]);

      expect(
        await directory.updateAccount('ann', { status: 'disabled' }),
      ).toMatchObject({ name: 'Ann A', status: 'disabled' });
      expect(
        await directory.updateAccount('ann', { name: null }),
      ).toMatchObject({
        name: null,
        status: 'disabled',
        createdAt: ann.createdAt,
      });
      expect(await directory.account('ann')).toMatchObject({
        name: null,
        status: 'disabled',
      });

      await directory.deleteAccount('bob');
      expect(await directory.account('bob')).toBeUndefined();
      expect((await directory.listAccounts()).map(({ id }) => id)).toEqual([
        'ann',
      ]);
    });

    it('refuses what is not a valid account', async () => {
      await directory.createAccount({ id: 'ann' });
      expect(await refusal(() => directory.createAccount({ id: 'ann' }))).toBe(
        'exists',
      );
      for (const id of ['', 'Ann', 'a b', 'a@b', 'x'.repeat(65), 'a#b']) {
        expect(await refusal(() => directory.createAccount({ id })), id).toBe(
          'invalid',
        );
      }
      for (const name of ['', '  ', 'two\nlines', 'x'.repeat(201)]) {
        expect(
          await refusal(() => directory.createAccount({ id: 'bob', name })),
        ).toBe('invalid');
      }
      expect(await directory.account('bob')).toBeUndefined();
      expect(
        await refusal(() =>
          directory.updateAccount('ann', { status: 'gone' as never }),
        ),
      ).toBe('invalid');
      expect(
        await refusal(() => directory.updateAccount('nobody', { name: 'x' })),
      ).toBe('notFound');
      expect(await refusal(() => directory.deleteAccount('nobody'))).toBe(
        'notFound',
      );
    });

    it('delivers an address to one account, the exact one before the whole domain', async () => {
      await directory.createAccount({ id: 'ann' });
      await directory.createAccount({ id: 'bob' });
      await directory.addAddress('ann', ' Ann@Example.com ');
      await directory.addAddress('ann', 'a.second@example.com');
      await directory.addAddress('bob', '*@example.com');
      // Saying it again changes nothing.
      await directory.addAddress('ann', 'ann@example.com');

      expect(await directory.addressesOf('ann')).toEqual([
        'a.second@example.com',
        'ann@example.com',
      ]);
      expect(await directory.addressesOf('bob')).toEqual(['*@example.com']);
      expect(await directory.addressesOf('nobody')).toEqual([]);
      expect(await directory.resolveAddress('ANN@example.COM')).toBe('ann');
      expect(await directory.resolveAddress('anyone@example.com')).toBe('bob');
      expect(
        await directory.resolveAddress('ann@other.example'),
      ).toBeUndefined();
      for (const nonsense of ['', 'no-at-sign', '@example.com', 'a b@c d']) {
        expect(await directory.resolveAddress(nonsense)).toBeUndefined();
      }

      expect(
        await refusal(() => directory.addAddress('bob', 'ann@example.com')),
      ).toBe('addressTaken');
      expect(
        await refusal(() => directory.addAddress('nobody', 'n@example.com')),
      ).toBe('notFound');
      expect(await refusal(() => directory.addAddress('ann', 'nonsense'))).toBe(
        'invalid',
      );
      expect(await directory.resolveAddress('n@example.com')).toBe('bob');

      // Only the account an address delivers to can give it up.
      expect(await directory.removeAddress('bob', 'ann@example.com')).toBe(
        false,
      );
      expect(await directory.removeAddress('ann', 'Ann@example.com')).toBe(
        true,
      );
      expect(await directory.removeAddress('ann', 'ann@example.com')).toBe(
        false,
      );
      expect(await directory.resolveAddress('ann@example.com')).toBe('bob');
      await directory.addAddress('bob', 'ann@example.com');
      expect(await directory.addressesOf('bob')).toEqual([
        '*@example.com',
        'ann@example.com',
      ]);
    });

    it('shares an account with other users', async () => {
      for (const id of ['ann', 'bob', 'team', 'records']) {
        await directory.createAccount({ id });
      }
      await directory.setShare('team', 'ann', 'member');
      await directory.setShare('team', 'bob', 'reader');
      await directory.setShare('records', 'ann', 'reader');

      expect(await directory.sharedWith('ann')).toEqual({
        team: 'member',
        records: 'reader',
      });
      expect(await directory.sharedWith('bob')).toEqual({ team: 'reader' });
      expect(await directory.sharedWith('team')).toEqual({});
      expect(await directory.sharesOf('team')).toEqual({
        ann: 'member',
        bob: 'reader',
      });

      // Set again, it is the new access that counts.
      await directory.setShare('team', 'bob', 'member');
      expect(await directory.sharedWith('bob')).toEqual({ team: 'member' });
      expect(await directory.sharesOf('team')).toEqual({
        ann: 'member',
        bob: 'member',
      });

      expect(await directory.removeShare('team', 'bob')).toBe(true);
      expect(await directory.removeShare('team', 'bob')).toBe(false);
      expect(await directory.sharedWith('bob')).toEqual({});

      expect(
        await refusal(() => directory.setShare('team', 'team', 'member')),
      ).toBe('invalid');
      expect(
        await refusal(() =>
          directory.setShare('team', 'ann', 'owner' as never),
        ),
      ).toBe('invalid');
      expect(
        await refusal(() => directory.setShare('team', 'nobody', 'reader')),
      ).toBe('notFound');
      expect(
        await refusal(() => directory.setShare('nowhere', 'ann', 'reader')),
      ).toBe('notFound');
    });

    it('leaves nothing of a deleted account behind', async () => {
      for (const id of ['ann', 'bob', 'team']) {
        await directory.createAccount({ id });
      }
      await directory.addAddress('ann', 'ann@example.com');
      await directory.addAddress('ann', '*@ann.example');
      await directory.setShare('team', 'ann', 'member');
      await directory.setShare('ann', 'bob', 'reader');

      await directory.deleteAccount('ann');
      expect(await directory.resolveAddress('ann@example.com')).toBeUndefined();
      expect(await directory.resolveAddress('x@ann.example')).toBeUndefined();
      expect(await directory.addressesOf('ann')).toEqual([]);
      expect(await directory.sharesOf('team')).toEqual({});
      expect(await directory.sharedWith('bob')).toEqual({});

      // A new account of the same id starts with nothing of the old one.
      await directory.createAccount({ id: 'ann' });
      expect(await directory.addressesOf('ann')).toEqual([]);
      expect(await directory.sharedWith('ann')).toEqual({});
      expect(await directory.sharesOf('ann')).toEqual({});
      await directory.addAddress('bob', 'ann@example.com');
      expect(await directory.resolveAddress('ann@example.com')).toBe('bob');
    });
  });
}
