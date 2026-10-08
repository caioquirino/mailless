import { InMemoryDirectory } from '@mailless/directory';
import { sharedAccountsFor } from './shares.js';

describe('sharedAccountsFor', () => {
  it('gives members the account and readers a read-only view of it', async () => {
    const directory = await InMemoryDirectory.from({
      names: { family: 'The family' },
      shares: {
        family: { members: ['ann', 'bob'], readers: ['carol'] },
        records: { readers: ['ann', 'bob'], members: ['bob'] },
        ann: { members: ['bob'] },
      },
    });
    expect(await sharedAccountsFor(directory, 'ann')).toEqual({
      family: { name: 'The family' },
      records: { name: 'records', isReadOnly: true },
    });
    expect(await sharedAccountsFor(directory, 'carol')).toEqual({
      family: { name: 'The family', isReadOnly: true },
    });
    // Listed as both, a user is a member.
    expect((await sharedAccountsFor(directory, 'bob'))['records']).toEqual({
      name: 'records',
    });
    expect(await sharedAccountsFor(directory, 'bob')).toHaveProperty('ann');
    expect(await sharedAccountsFor(directory, 'mallory')).toEqual({});

    // An account that is switched off is offered to nobody.
    await directory.updateAccount('family', { status: 'disabled' });
    expect(await sharedAccountsFor(directory, 'carol')).toEqual({});
    expect(await sharedAccountsFor(directory, 'ann')).not.toHaveProperty(
      'family',
    );
  });
});
