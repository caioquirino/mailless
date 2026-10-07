import { identitiesFor } from './identities.js';

describe('identitiesFor', () => {
  it('never offers a wildcard as an address to send from', () => {
    const identities = identitiesFor({ '*@example.com': 'caio' }, 'caio', {
      caio: 'Caio Quirino',
    });
    expect(identities).toEqual([
      {
        id: expect.stringMatching(/^id[0-9a-f]{24}$/),
        email: 'caio@example.com',
        name: 'Caio Quirino',
        allowedFrom: ['*@example.com'],
      },
    ]);
  });

  it('uses the addresses an account has, and lets them send across its catch-all domains', () => {
    const identities = identitiesFor(
      {
        '*@example.com': 'me',
        'hello@example.com': 'me',
        'me@example.com': 'me',
        'alias@example.org': 'me',
        '*@example.net': 'me',
        'other@example.com': 'someone-else',
      },
      'me',
    );
    expect(identities.map((identity) => identity.email)).toEqual([
      'me@example.com',
      'me@example.net',
      'alias@example.org',
      'hello@example.com',
    ]);
    for (const identity of identities) {
      expect(identity.email).not.toContain('*');
      expect(identity.allowedFrom).toEqual(['*@example.com', '*@example.net']);
      expect(identity).not.toHaveProperty('name');
    }
    expect(new Set(identities.map((identity) => identity.id)).size).toBe(4);
  });

  it('keeps ids stable and other accounts out', () => {
    const mailboxes = {
      'me@example.com': 'me',
      'other@example.com': 'someone-else',
    };
    expect(identitiesFor(mailboxes, 'me')).toEqual(
      identitiesFor({ ...mailboxes }, 'me'),
    );
    expect(identitiesFor(mailboxes, 'me')[0]?.allowedFrom).toEqual([]);
    expect(
      identitiesFor(mailboxes, 'someone-else').map((i) => i.email),
    ).toEqual(['other@example.com']);
    expect(identitiesFor(mailboxes, 'nobody')).toEqual([]);
  });
});
