import { identitiesFor } from './identities.js';

describe('identitiesFor', () => {
  const mailboxes = {
    '*@example.com': 'me',
    'me@example.com': 'me',
    'alias@example.org': 'me',
    'other@example.com': 'someone-else',
  };

  it('gives an account the addresses that deliver to it, exact ones first', () => {
    const identities = identitiesFor(mailboxes, 'me');
    expect(identities.map((identity) => identity.email)).toEqual([
      'alias@example.org',
      'me@example.com',
      '*@example.com',
    ]);
    for (const identity of identities)
      expect(identity.id).toMatch(/^id[0-9a-f]{24}$/);
    expect(new Set(identities.map((identity) => identity.id)).size).toBe(3);
  });

  it('keeps ids stable and other accounts out', () => {
    expect(identitiesFor(mailboxes, 'me')).toEqual(
      identitiesFor({ ...mailboxes }, 'me'),
    );
    expect(
      identitiesFor(mailboxes, 'someone-else').map((i) => i.email),
    ).toEqual(['other@example.com']);
    expect(identitiesFor(mailboxes, 'nobody')).toEqual([]);
  });
});
