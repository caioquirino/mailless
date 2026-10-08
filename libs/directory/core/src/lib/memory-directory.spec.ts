import { DirectoryError } from './directory.js';
import { describeDirectoryContract } from './directory-contract.js';
import { InMemoryDirectory } from './memory-directory.js';

describeDirectoryContract('in-memory', async () => new InMemoryDirectory());

describe('InMemoryDirectory.from', () => {
  it('builds a directory from configuration', async () => {
    const directory = await InMemoryDirectory.from({
      mailboxes: {
        'Ann@example.com': 'ann',
        '*@example.com': 'bob',
        'team@example.com': 'team',
      },
      names: { ann: 'Ann A', team: 'The Team' },
      shares: { team: { members: ['ann'], readers: ['ann', 'bob', 'team'] } },
    });
    expect(
      (await directory.listAccounts()).map(({ id, name }) => [id, name]),
    ).toEqual([
      ['ann', 'Ann A'],
      ['bob', null],
      ['team', 'The Team'],
    ]);
    expect(await directory.resolveAddress('ann@example.com')).toBe('ann');
    expect(await directory.resolveAddress('other@example.com')).toBe('bob');
    // Listed as both, a user is a member; an account is not shared with itself.
    expect(await directory.sharesOf('team')).toEqual({
      ann: 'member',
      bob: 'reader',
    });
  });

  it('refuses configuration a directory would refuse', async () => {
    await expect(
      InMemoryDirectory.from({ mailboxes: { 'a@example.com': 'Ann' } }),
    ).rejects.toThrow(DirectoryError);
  });
});
