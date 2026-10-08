import {
  CONFIG,
  fakeBackend,
  ORIGIN,
  signIn,
  testSession,
} from '../test-support';
import { challengeFor } from './pkce';
import { SignInError } from './session';

describe('Session', () => {
  it('sends the browser to the provider with a challenge, keeping the verifier for the way back', async () => {
    const { session, visited } = testSession(fakeBackend());
    await session.beginSignIn();

    const url = new URL(visited[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(CONFIG.authorizeUrl);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'admin-client',
      redirect_uri: `${ORIGIN}/admin/callback`,
      scope: 'openid aws.cognito.signin.user.admin',
      code_challenge_method: 'S256',
    });
    const pending = JSON.parse(
      window.sessionStorage.getItem('mailless.admin.sign-in') as string,
    );
    expect(pending.state).toBe(params['state']);
    expect(await challengeFor(pending.verifier)).toBe(params['code_challenge']);
    // Only the challenge travels: the verifier is not in the address.
    expect(url.href).not.toContain(pending.verifier);
    expect(session.isSignedIn).toBe(false);
  });

  it('exchanges the code and keeps the tokens for this tab, and nowhere that outlives it', async () => {
    const backend = fakeBackend();
    const { session, visited } = testSession(backend);
    const changes = vi.fn();
    session.subscribe(changes);
    await session.beginSignIn();
    const sent = new URL(visited[0] as string).searchParams;
    const { verifier } = JSON.parse(
      window.sessionStorage.getItem('mailless.admin.sign-in') as string,
    );

    expect(
      await session.completeSignIn(
        new URLSearchParams({ code: 'code-1', state: sent.get('state') ?? '' }),
      ),
    ).toBe(true);
    expect(backend.state.tokenRequests).toEqual([
      {
        grant_type: 'authorization_code',
        client_id: 'admin-client',
        code: 'code-1',
        redirect_uri: `${ORIGIN}/admin/callback`,
        code_verifier: verifier,
      },
    ]);
    expect(session.isSignedIn).toBe(true);
    expect(session.accessToken()).toBe('access-1');
    expect(changes).toHaveBeenCalledTimes(1);
    // The verifier was used once and is gone. The tokens are kept for this tab,
    // with a note that it was signed in; nothing is kept where it would outlive the tab.
    expect(Object.keys({ ...window.sessionStorage }).sort()).toEqual([
      'mailless.admin.tokens',
      'mailless.admin.was-signed-in',
    ]);
    expect(
      JSON.parse(
        window.sessionStorage.getItem('mailless.admin.tokens') as string,
      ),
    ).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: expect.any(Number),
    });
    expect(
      JSON.stringify([{ ...window.localStorage }, document.cookie]),
    ).not.toMatch(/access-1|refresh-1/);
  });

  it('exchanges a code once, however often it is asked to', async () => {
    const backend = fakeBackend();
    const { session, visited } = testSession(backend);
    await session.beginSignIn();
    const state = new URL(visited[0] as string).searchParams.get('state') ?? '';
    const params = () => new URLSearchParams({ code: 'code-1', state });
    // As React does in development: the same arrival, handled twice.
    const [first, second] = await Promise.all([
      session.completeSignIn(params()),
      session.completeSignIn(params()),
    ]);
    expect([first, second]).toEqual([true, true]);
    expect(backend.state.tokenRequests).toHaveLength(1);
  });

  it('refuses a code that does not belong to a sign-in started here', async () => {
    const backend = fakeBackend();
    const { session } = testSession(backend);
    const arrive = (params: Record<string, string>) =>
      session.completeSignIn(new URLSearchParams(params));

    // Nothing was started.
    await expect(arrive({ code: 'c1', state: 'anything' })).rejects.toThrow(
      SignInError,
    );
    // Something was started, but this is not its state.
    await session.beginSignIn();
    await expect(
      arrive({ code: 'c2', state: 'not-the-state' }),
    ).rejects.toThrow(/not started from this page/);
    // The attempt used up what was kept, so the right state is too late as well.
    expect(window.sessionStorage.length).toBe(0);
    await session.beginSignIn();
    await expect(arrive({ code: 'c3' })).rejects.toThrow(SignInError);

    expect(backend.state.tokenRequests).toEqual([]);
    expect(session.isSignedIn).toBe(false);
  });

  it('says so when the provider refuses, without repeating what it was sent', async () => {
    const backend = fakeBackend();
    const { session, visited } = testSession(backend);

    await expect(
      session.completeSignIn(
        new URLSearchParams({ error: 'access_denied', state: 'x' }),
      ),
    ).rejects.toThrow('Sign-in was cancelled.');
    await expect(
      session.completeSignIn(new URLSearchParams({ error: 'server_error' })),
    ).rejects.toThrow('The sign-in page reported a problem.');

    backend.state.nextAccessToken = null;
    await session.beginSignIn();
    const state = new URL(visited[0] as string).searchParams.get('state') ?? '';
    const failed = await session
      .completeSignIn(new URLSearchParams({ code: 'secret-code', state }))
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SignInError);
    expect((failed as Error).message).toBe(
      'Sign-in could not be completed. Please try again.',
    );
    expect((failed as Error).message).not.toContain('secret-code');
    expect(session.isSignedIn).toBe(false);
  });

  it('has nothing to finish when the provider sends someone back without a code', async () => {
    const backend = fakeBackend();
    const { session, visited } = testSession(backend);
    expect(await session.completeSignIn(new URLSearchParams())).toBe(false);
    await signIn(session, visited);
    // As after adding a passkey: back here, still signed in.
    expect(await session.completeSignIn(new URLSearchParams())).toBe(true);
    expect(backend.state.tokenRequests).toHaveLength(1);
  });

  it('renews the access token with the refresh token, and keeps that token', async () => {
    const backend = fakeBackend();
    const { session, visited } = testSession(backend);
    expect(await session.renew()).toBe(false);
    await signIn(session, visited);

    backend.state.nextAccessToken = 'access-2';
    // Asked twice at once, it renews once.
    expect(await Promise.all([session.renew(), session.renew()])).toEqual([
      true,
      true,
    ]);
    expect(session.accessToken()).toBe('access-2');
    expect(backend.state.tokenRequests.at(-1)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'admin-client',
      refresh_token: 'refresh-1',
    });
    expect(backend.state.tokenRequests).toHaveLength(2);

    // The renewal gave no new refresh token; the first one still works.
    backend.state.nextAccessToken = 'access-3';
    expect(await session.renew()).toBe(true);
    expect(session.accessToken()).toBe('access-3');

    backend.state.nextAccessToken = null;
    expect(await session.renew()).toBe(false);
    // What is kept for a reload is what is in use: the newest token, not the first.
    expect(window.sessionStorage.getItem('mailless.admin.tokens')).toContain(
      'access-3',
    );
    expect(
      JSON.stringify([{ ...window.localStorage }, document.cookie]),
    ).not.toMatch(/access-|refresh-/);
  });

  it('signs out here and at the provider', async () => {
    const { session, visited } = testSession(fakeBackend());
    await signIn(session, visited);
    const changes = vi.fn();
    session.subscribe(changes);

    session.signOut();
    expect(session.isSignedIn).toBe(false);
    expect(session.accessToken()).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(1);
    const url = new URL(visited.at(-1) as string);
    expect(`${url.origin}${url.pathname}`).toBe(CONFIG.logoutUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'admin-client',
      logout_uri: `${ORIGIN}/admin/`,
    });
    expect(await session.renew()).toBe(false);
  });

  it('goes to the provider’s page for adding a passkey, which comes back here', async () => {
    const { session, visited } = testSession(fakeBackend());
    await signIn(session, visited);
    session.addPasskey();
    const url = new URL(visited.at(-1) as string);
    expect(`${url.origin}${url.pathname}`).toBe(CONFIG.passkeyEnrolmentUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'admin-client',
      redirect_uri: `${ORIGIN}/admin/callback`,
    });
    // Nothing of the session is in the address.
    expect(url.href).not.toMatch(/access-1|refresh-1/);
  });
});
