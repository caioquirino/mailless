import { createAuthenticator, type AuthFailure } from './authenticator.js';

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const request = (authorization?: string) =>
  new Request('https://mail.example.com/jmap/api', {
    headers: authorization === undefined ? {} : { authorization },
  });

function setup() {
  const appLogins: Array<[string, string]> = [];
  const revoked = new Set<string>();
  let time = 1_000_000;
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
    isAppPassword: (password) => password.startsWith('mlapp-'),
    appPasswordLogin: async (username, password) => {
      appLogins.push([username, password]);
      if (password === 'mlapp-boom') throw new Error('table unavailable');
      return password.startsWith('mlapp-good') && !revoked.has(password)
        ? username
        : null;
    },
  });
  return {
    authenticate,
    verified,
    failures,
    appLogins,
    revoked,
    advance: (ms: number) => (time += ms),
  };
}

describe('createAuthenticator', () => {
  it('accepts a valid bearer token and uses its username as the account', async () => {
    const { authenticate, appLogins } = setup();
    expect(await authenticate(request('Bearer token-for-me'))).toEqual({
      accountId: 'me',
      username: 'me',
    });
    expect(await authenticate(request('bearer token-for-me'))).not.toBeNull();
    expect(appLogins).toEqual([]);
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
    expect(
      await authenticate(request(basic('../other', 'mlapp-good'))),
    ).toBeNull();
  });

  it('refuses a password that is not an app password, without looking anything up', async () => {
    const { authenticate, appLogins, failures } = setup();
    expect(
      await authenticate(request(basic('me', 'correct horse'))),
    ).toBeNull();
    expect(appLogins).toEqual([]);
    expect(failures.at(-1)).toEqual({
      scheme: 'basic',
      reason: 'refused',
      credentialKind: 'password',
      usernameKind: 'name',
    });
  });

  it('checks an app password once and remembers the answer for a minute', async () => {
    const { authenticate, appLogins, advance } = setup();
    const header = basic('me', 'mlapp-good');

    expect(await authenticate(request(header))).toEqual({
      accountId: 'me',
      username: 'me',
    });
    await authenticate(request(header));
    advance(59_000);
    await authenticate(request(header));
    expect(appLogins).toEqual([['me', 'mlapp-good']]);

    advance(2_000);
    await authenticate(request(header));
    expect(appLogins).toHaveLength(2);
  });

  it('keeps passwords containing colons intact', async () => {
    const { authenticate, appLogins } = setup();
    await authenticate(request(basic('me', 'mlapp-good:with:colons')));
    expect(appLogins).toEqual([['me', 'mlapp-good:with:colons']]);
  });

  it('remembers a refusal only briefly', async () => {
    const { authenticate, appLogins, advance } = setup();
    const header = basic('me', 'mlapp-wrong');
    expect(await authenticate(request(header))).toBeNull();
    expect(await authenticate(request(header))).toBeNull();
    expect(appLogins).toHaveLength(1);

    advance(31_000);
    await authenticate(request(header));
    expect(appLogins).toHaveLength(2);
  });

  it('does not let one password vouch for another', async () => {
    const { authenticate } = setup();
    expect(
      await authenticate(request(basic('me', 'mlapp-good'))),
    ).not.toBeNull();
    expect(await authenticate(request(basic('me', 'mlapp-wrong')))).toBeNull();
    expect(
      await authenticate(request(basic('other', 'mlapp-wrong'))),
    ).toBeNull();
  });

  it('looks up once for simultaneous requests with the same credentials', async () => {
    const { authenticate, appLogins } = setup();
    const header = basic('me', 'mlapp-good');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => authenticate(request(header))),
    );
    expect(results.every((result) => result?.accountId === 'me')).toBe(true);
    expect(appLogins).toHaveLength(1);
  });

  it('signs in with an email address as the account that owns it', async () => {
    const { authenticate, appLogins } = setup();
    expect(
      await authenticate(request(basic('Anything@Example.com', 'mlapp-good'))),
    ).toEqual({
      accountId: 'me',
      username: 'me',
    });
    expect(appLogins).toEqual([['me', 'mlapp-good']]);

    // An address nobody owns is tried as typed, and is no account.
    expect(
      await authenticate(request(basic('x@elsewhere.org', 'mlapp-good'))),
    ).toBeNull();
    // The address still needs the right password.
    expect(
      await authenticate(request(basic('me@example.com', 'mlapp-wrong'))),
    ).toBeNull();
  });

  it('reports why a request was not authenticated, without the credentials', async () => {
    const { authenticate, failures } = setup();
    await authenticate(request());
    await authenticate(request('Bearer forged-token-value'));
    await authenticate(request(basic('me', 'secret-wrong-password')));
    await authenticate(request(basic('me@example.com', 'mlapp-wrong-secret')));
    await authenticate(request('Basic !!!'));
    await authenticate(request('Digest abc'));
    await authenticate(request('SuperSecretScheme abc'));
    await authenticate(request('Bearer'));
    expect(failures).toEqual([
      { scheme: 'none', reason: 'missing' },
      { scheme: 'bearer', reason: 'refused' },
      {
        scheme: 'basic',
        reason: 'refused',
        credentialKind: 'password',
        usernameKind: 'name',
      },
      {
        scheme: 'basic',
        reason: 'refused',
        credentialKind: 'app-password',
        usernameKind: 'address',
      },
      { scheme: 'basic', reason: 'malformed' },
      { scheme: 'digest', reason: 'unsupported-scheme' },
      { scheme: 'other', reason: 'unsupported-scheme' },
      { scheme: 'bearer', reason: 'malformed' },
    ]);
    const text = JSON.stringify(failures);
    for (const secret of [
      'forged-token-value',
      'secret-wrong-password',
      'mlapp-wrong-secret',
      'SuperSecretScheme',
      'me@example.com',
    ]) {
      expect(text).not.toContain(secret);
    }

    const before = failures.length;
    await authenticate(request(basic('me', 'mlapp-good')));
    expect(failures).toHaveLength(before);
  });

  it('stops accepting a revoked app password within a minute', async () => {
    const { authenticate, revoked, advance, appLogins } = setup();
    const header = basic('me', 'mlapp-good');
    expect(await authenticate(request(header))).not.toBeNull();

    revoked.add('mlapp-good');
    advance(59_000);
    expect(await authenticate(request(header))).not.toBeNull();
    expect(appLogins).toHaveLength(1);

    advance(2_000);
    expect(await authenticate(request(header))).toBeNull();
  });

  it('surfaces failures of the lookup and does not cache them', async () => {
    const { authenticate, appLogins } = setup();
    const header = basic('me', 'mlapp-boom');
    await expect(authenticate(request(header))).rejects.toThrow('unavailable');
    await expect(authenticate(request(header))).rejects.toThrow('unavailable');
    expect(appLogins).toHaveLength(2);
  });
});
