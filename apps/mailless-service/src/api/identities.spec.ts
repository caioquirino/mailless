import { identitiesFor } from './identities.js';

describe('identitiesFor', () => {
  it('never offers a wildcard as an address to send from', () => {
    const identities = identitiesFor('caio', ['*@example.com'], 'Caio Quirino');
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
    const identities = identitiesFor('me', [
      '*@example.com',
      'hello@example.com',
      'me@example.com',
      'alias@example.org',
      '*@example.net',
    ]);
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

  it('keeps ids stable, and gives an account without addresses none', () => {
    const addresses = ['me@example.com'];
    expect(identitiesFor('me', addresses)).toEqual(
      identitiesFor('me', [...addresses]),
    );
    expect(identitiesFor('me', addresses)[0]?.allowedFrom).toEqual([]);
    expect(identitiesFor('me', addresses, null)[0]).not.toHaveProperty('name');
    expect(identitiesFor('nobody', [])).toEqual([]);
  });
});
