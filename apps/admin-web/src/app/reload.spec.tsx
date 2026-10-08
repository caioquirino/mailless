import { screen, waitFor } from '@testing-library/react';
import { fakeBackend, renderApp, testSession } from '../test-support';

const TOKENS = 'mailless.admin.tokens';
const kept = () =>
  JSON.parse(window.sessionStorage.getItem(TOKENS) as string) as {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number;
  };

describe('reloading the page', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('stays signed in, on the page it was on, without going anywhere', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    const before = await renderApp(backend, '/accounts/bob');
    expect(
      await screen.findByRole('heading', { level: 1, name: /bob/ }),
    ).toBeInTheDocument();
    before.unmount();

    // The reload: the same tab, with nothing left in memory.
    const reloaded = await renderApp(backend, '/accounts/bob', {
      signedIn: false,
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: /bob/ }),
    ).toBeInTheDocument();
    expect(reloaded.session.isSignedIn).toBe(true);
    // Neither the provider's pages nor its token endpoint were needed for it.
    expect(reloaded.visited).toEqual([]);
    expect(backend.state.tokenRequests).toHaveLength(1);
  });

  it('renews what ran out while the tab was away, and goes on', async () => {
    const backend = fakeBackend();
    (await renderApp(backend, '/')).unmount();
    window.sessionStorage.setItem(
      TOKENS,
      JSON.stringify({ ...kept(), expiresAt: Date.now() - 1000 }),
    );
    backend.state.nextAccessToken = 'access-2';

    const { session, visited } = testSession(backend);
    expect(session.isSignedIn).toBe(false);
    await session.restore();
    expect(session.accessToken()).toBe('access-2');
    expect(backend.state.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
    expect(kept().accessToken).toBe('access-2');
    expect(visited).toEqual([]);
  });

  it('goes to the provider once when what it kept can no longer be renewed, and comes back to the same page', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    (await renderApp(backend, '/accounts/bob')).unmount();
    window.sessionStorage.setItem(
      TOKENS,
      JSON.stringify({ ...kept(), expiresAt: Date.now() - 1000 }),
    );
    // The provider will not renew it.
    backend.state.nextAccessToken = null;

    const first = testSession(backend);
    await first.session.restore();
    expect(first.session.isSignedIn).toBe(false);
    // What could not be renewed is not kept.
    expect(window.sessionStorage.getItem(TOKENS)).toBeNull();

    const reloaded = await renderApp(backend, '/accounts/bob', {
      signedIn: false,
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Signing you in again',
    );
    await waitFor(() => expect(reloaded.visited).toHaveLength(1));
    const authorize = new URL(reloaded.visited[0] as string);
    expect(authorize.pathname).toBe('/oauth2/authorize');
    reloaded.unmount();

    backend.state.nextAccessToken = 'access-9';
    await renderApp(
      backend,
      `/callback?code=code-1&state=${authorize.searchParams.get('state')}`,
      { signedIn: false },
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: /bob/ }),
    ).toBeInTheDocument();
  });

  it('tries the provider once: if that came to nothing, the user is asked', async () => {
    const backend = fakeBackend();
    (await renderApp(backend, '/')).unmount();
    window.sessionStorage.removeItem(TOKENS);

    const first = await renderApp(backend, '/', { signedIn: false });
    await waitFor(() => expect(first.visited).toHaveLength(1));
    first.unmount();

    const second = await renderApp(backend, '/', { signedIn: false });
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(second.visited).toEqual([]);
  });

  it('keeps nothing of someone who signed out', async () => {
    const backend = fakeBackend();
    const view = await renderApp(backend, '/');
    view.session.signOut();
    view.unmount();
    expect(window.sessionStorage.length).toBe(0);

    const after = await renderApp(backend, '/', { signedIn: false });
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(after.visited).toEqual([]);
  });

  it('does not take what is kept on trust', async () => {
    const backend = fakeBackend();
    for (const nonsense of [
      'not json',
      '{}',
      '{"accessToken":"","expiresAt":9999999999999,"refreshToken":null}',
      '{"accessToken":"x","expiresAt":"soon","refreshToken":null}',
      '{"accessToken":"x","expiresAt":9999999999999,"refreshToken":7}',
    ]) {
      window.sessionStorage.setItem(TOKENS, nonsense);
      const { session } = testSession(backend);
      await session.restore();
      expect(session.isSignedIn, nonsense).toBe(false);
    }
  });

  it('only ever comes back to an address inside the interface', async () => {
    const backend = fakeBackend();
    const { session, visited } = testSession(backend);
    for (const elsewhere of [
      '//evil.example',
      'https://evil.example',
      '/callback?x',
    ]) {
      await session.beginSignIn(elsewhere);
      const state = new URL(visited.at(-1) as string).searchParams.get('state');
      await session.completeSignIn(
        new URLSearchParams({
          code: `code-${elsewhere}`,
          state: state as string,
        }),
      );
      expect(session.takeReturnPath(), elsewhere).toBe('/');
    }
  });
});
