import { parseAccountShares, sharedAccountsFor } from './shares.js';

const shares = {
  family: { members: ['ann', 'bob'], readers: ['carol'] },
  records: { readers: ['ann', 'bob'], members: ['bob'] },
  ann: { members: ['ann', 'bob'] },
};

describe('sharedAccountsFor', () => {
  it('gives members the account and readers a read-only view of it', () => {
    expect(sharedAccountsFor(shares, 'ann', { family: 'The family' })).toEqual({
      family: { name: 'The family' },
      records: { name: 'records', isReadOnly: true },
    });
    expect(sharedAccountsFor(shares, 'carol')).toEqual({
      family: { name: 'family', isReadOnly: true },
    });
  });

  it('treats someone listed as both member and reader as a member', () => {
    expect(sharedAccountsFor(shares, 'bob')['records']).toEqual({
      name: 'records',
    });
  });

  it("never lists a user's own account, or anything for a stranger", () => {
    expect(sharedAccountsFor(shares, 'ann')).not.toHaveProperty('ann');
    expect(sharedAccountsFor(shares, 'bob')).toHaveProperty('ann');
    expect(sharedAccountsFor(shares, 'mallory')).toEqual({});
    expect(sharedAccountsFor({}, 'ann')).toEqual({});
  });
});

describe('parseAccountShares', () => {
  it('reads the setting, and treats none as no shares', () => {
    expect(parseAccountShares(undefined)).toEqual({});
    expect(parseAccountShares('')).toEqual({});
    expect(parseAccountShares('{"team":{"members":["ann"]}}')).toEqual({
      team: { members: ['ann'] },
    });
    expect(() => parseAccountShares('[]')).toThrow(/JSON object/);
  });
});
