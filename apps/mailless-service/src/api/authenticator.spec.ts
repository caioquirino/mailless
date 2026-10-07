import { createAuthenticator, type AuthFailure } from './authenticator.js';

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const request = (authorization?: string) =>
  new Request('https://mail.example.com/jmap/api', {
    headers: authorization === undefined ? {} : { authorization },
  });

function setup() {
  let time = 1_000_000;
  const logins: Array<[string, string]> = [];
  const verified: string[] = [];
  const failures: AuthFailure[] = [];
  const authenticate = createAuthenticator({
    onFailure: (failure) => failures.push(failure),
    resolveUsername: (username) =>
      username.toLowerCase().endsWith('@example.com') ? 'me' : username,
    now: () => time,
    verifyAccessToken: async (token) => {
      verified.push(token);
      if (!token.startsWith('token-for-')) throw new Error('invalid token');
      return token.slice('token-for-'.length);
    },
    passwordLogin: async (username, password) => {
      logins.push([username, password]);
      if (password === 'boom') throw new Error('identity provider unavailable');
      // The provider accepts any spelling of the name and reports the canonical one.
      return password === 'correct horse'
        ? `token-for-${username.toLowerCase()}`
        : null;
    },
  });
  return {
    authenticate,
    logins,
    verified,
    failures,
    advance: (ms: number) => (time += ms),
  };
}

describe('createAuthenticator', () => {
  it('accepts a valid bearer token and uses its username as the account', async () => {
    const { authenticate, logins } = setup();
    expect(await authenticate(request('Bearer token-for-me'))).toEqual({
      accountId: 'me',
      username: 'me',
    });
    expect(await authenticate(request('bearer token-for-me'))).not.toBeNull();
    expect(logins).toEqual([]);
  });

  it('rejects missing, malformed and invalid credentials', async () => {
    const { authenticate } = setup();
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Bearer forged',
      'Digest abc',
      'Basic',
      'Basic !!!not-base64!!!',
      `Basic ${Buffer.from('no-colon').toString('base64')}`,
      `Basic ${Buffer.from(':nopassword').toString('base64')}`,
      `Basic ${Buffer.from('nouser:').toString('base64')}`,
      `Basic ${Buffer.from([0xff, 0x3a, 0x61]).toString('base64')}`,
    ]) {
      expect(await authenticate(request(header)), String(header)).toBeNull();
    }
  });

  it('refuses usernames that cannot be account ids', async () => {
    const { authenticate } = setup();
    expect(await authenticate(request('Bearer token-for-../other'))).toBeNull();
    expect(await authenticate(request('Bearer token-for-a b'))).toBeNull();
  });

  it('checks a password once and remembers the answer for five minutes', async () => {
    const { authenticate, logins, advance } = setup();
    const header = basic('Me', 'correct horse');

    expect(await authenticate(request(header))).toEqual({
      accountId: 'me',
      username: 'me',
    });
    await authenticate(request(header));
    advance(4 * 60_000);
    await authenticate(request(header));
    expect(logins).toEqual([['Me', 'correct horse']]);

    advance(2 * 60_000);
    await authenticate(request(header));
    expect(logins).toHaveLength(2);
  });

  it('keeps passwords containing colons intact', async () => {
    const { authenticate, logins } = setup();
    await authenticate(request(basic('me', 'pa:ss:word')));
    expect(logins).toEqual([['me', 'pa:ss:word']]);
  });

  it('remembers a refusal only briefly', async () => {
    const { authenticate, logins, advance } = setup();
    const header = basic('me', 'wrong');
    expect(await authenticate(request(header))).toBeNull();
    expect(await authenticate(request(header))).toBeNull();
    expect(logins).toHaveLength(1);

    advance(31_000);
    await authenticate(request(header));
    expect(logins).toHaveLength(2);
  });

  it('does not let one password vouch for another', async () => {
    const { authenticate } = setup();
    expect(
      await authenticate(request(basic('me', 'correct horse'))),
    ).not.toBeNull();
    expect(await authenticate(request(basic('me', 'wrong')))).toBeNull();
    expect(await authenticate(request(basic('other', 'wrong')))).toBeNull();
  });

  it('signs in once for simultaneous requests with the same credentials', async () => {
    const { authenticate, logins } = setup();
    const header = basic('me', 'correct horse');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => authenticate(request(header))),
    );
    expect(results.every((result) => result?.accountId === 'me')).toBe(true);
    expect(logins).toHaveLength(1);
  });

  it('signs in with an email address as the account that owns it', async () => {
    const { authenticate, logins } = setup();
    expect(
      await authenticate(
        request(basic('Anything@Example.com', 'correct horse')),
      ),
    ).toEqual({
      accountId: 'me',
      username: 'me',
    });
    expect(logins).toEqual([['me', 'correct horse']]);

    // An address nobody owns is tried as typed, and refused by the provider.
    expect(
      await authenticate(request(basic('x@elsewhere.org', 'wrong'))),
    ).toBeNull();
    expect(logins[1]).toEqual(['x@elsewhere.org', 'wrong']);
    // The address still needs the right password.
    expect(
      await authenticate(request(basic('me@example.com', 'wrong'))),
    ).toBeNull();
  });

  it('reports why a request was not authenticated, without the credentials', async () => {
    const { authenticate, failures } = setup();
    await authenticate(request());
    await authenticate(request('Bearer forged-token-value'));
    await authenticate(request(basic('me', 'secret-wrong-password')));
    await authenticate(
      request(basic('me@example.com', 'secret-wrong-password')),
    );
    await authenticate(request('Basic !!!'));
    await authenticate(request('Digest abc'));
    await authenticate(request('SuperSecretScheme abc'));
    await authenticate(request('Bearer'));
    expect(failures).toEqual([
      { scheme: 'none', reason: 'missing' },
      { scheme: 'bearer', reason: 'refused' },
      { scheme: 'basic', reason: 'refused', usernameKind: 'name' },
      { scheme: 'basic', reason: 'refused', usernameKind: 'address' },
      { scheme: 'basic', reason: 'malformed' },
      { scheme: 'digest', reason: 'unsupported-scheme' },
      { scheme: 'other', reason: 'unsupported-scheme' },
      { scheme: 'bearer', reason: 'malformed' },
    ]);
    const text = JSON.stringify(failures);
    for (const secret of [
      'forged-token-value',
      'secret-wrong-password',
      'SuperSecretScheme',
      'me@example.com',
    ]) {
      expect(text).not.toContain(secret);
    }

    const before = failures.length;
    await authenticate(request(basic('me', 'correct horse')));
    expect(failures).toHaveLength(before);
  });

  it('surfaces provider failures and does not cache them', async () => {
    const { authenticate, logins } = setup();
    const header = basic('me', 'boom');
    await expect(authenticate(request(header))).rejects.toThrow('unavailable');
    await expect(authenticate(request(header))).rejects.toThrow('unavailable');
    expect(logins).toHaveLength(2);
  });
});
