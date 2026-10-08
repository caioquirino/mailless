import { fakeBackend, ORIGIN, signIn, testSession } from '../test-support';
import { ApiFailure, createApi, failureMessage } from './api';
import { parseConfig } from './config';

async function setup(options: Parameters<typeof fakeBackend>[0] = {}) {
  const backend = fakeBackend(options);
  const { session, visited } = testSession(backend);
  await signIn(session, visited);
  const api = createApi(session, `${ORIGIN}/admin/api`, backend.fetch);
  return { backend, session, api };
}

describe('the API as the page calls it', () => {
  it('sends the token with each call and hands back the answer', async () => {
    const { api, backend } = await setup();
    expect((await api.me()).username).toBe('ann');
    expect(backend.state.calls).toEqual([
      { method: 'GET', path: '/me', body: undefined, token: 'access-1' },
    ]);
    // An answer with nothing in it is not a failure.
    await api.removeMyPasskey('p1');
    expect(backend.state.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/me/passkeys/p1',
    });
  });

  it('throws the API’s refusal, with its word and its message', async () => {
    const { api } = await setup();
    const refused = await api.accounts().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiFailure);
    expect(refused).toMatchObject({
      code: 'forbidden',
      status: 403,
      message: 'Only an administrator may do this',
    });
    expect(failureMessage(refused)).toBe('Only an administrator may do this');
    expect(failureMessage(new Error('anything else'))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('renews a token that ran out and tries the call once more', async () => {
    const { api, backend, session } = await setup();
    backend.state.accepted.clear();
    backend.state.nextAccessToken = 'access-2';

    expect((await api.me()).username).toBe('ann');
    expect(backend.state.calls.map((call) => call.token)).toEqual([
      'access-1',
      'access-2',
    ]);
    expect(session.isSignedIn).toBe(true);
  });

  it('signs the user out here when a fresh token is refused too', async () => {
    const { api, backend, session } = await setup();
    backend.state.accepted.clear();
    backend.state.nextAccessToken = null;

    await expect(api.me()).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'You have been signed out. Please sign in again.',
    });
    expect(session.isSignedIn).toBe(false);
    // One call, no second try without a token to try it with.
    expect(backend.state.calls).toHaveLength(1);
  });

  it('says that the server could not be reached when nothing answers', async () => {
    const backend = fakeBackend();
    const { session, visited } = testSession(backend);
    await signIn(session, visited);
    const api = createApi(session, `${ORIGIN}/admin/api`, (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    await expect(api.me()).rejects.toMatchObject({
      code: 'unreachable',
      status: 0,
    });
    expect(session.isSignedIn).toBe(true);
  });
});

describe('parseConfig', () => {
  const valid = {
    apiBaseUrl: '/admin/api',
    clientId: 'c',
    authorizeUrl: 'https://auth.example.com/a',
    tokenUrl: 'https://auth.example.com/t',
    logoutUrl: 'https://auth.example.com/l',
    scopes: ['openid'],
    passkeyEnrolmentUrl: null,
  };

  it('takes what the server sends, and says what is missing', () => {
    expect(parseConfig(valid)).toEqual(valid);
    expect(
      parseConfig({
        ...valid,
        passkeyEnrolmentUrl: 'https://auth.example.com/p',
      }).passkeyEnrolmentUrl,
    ).toBe('https://auth.example.com/p');
    expect(() => parseConfig({ ...valid, tokenUrl: '' })).toThrow(/tokenUrl/);
    expect(() => parseConfig({ ...valid, scopes: 'openid' })).toThrow(/scopes/);
    expect(() => parseConfig(null)).toThrow(/apiBaseUrl/);
  });
});
