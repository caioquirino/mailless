import { fakeBackend, CONFIG, signIn, testSession } from '../test-support';
import { createMailClient } from './client';

describe('createMailClient', () => {
  it('calls the server as whoever is signed in', async () => {
    const backend = await fakeBackend();
    const { session, visited } = testSession(backend);
    await signIn(session, visited);
    const client = createMailClient({
      sessionUrl: CONFIG.sessionUrl,
      session,
      fetch: backend.fetch,
    });
    expect((await client.session()).username).toBe('ann@example.com');
  });

  it('renews a token that ran out and tries once more', async () => {
    const backend = await fakeBackend();
    const { session, visited } = testSession(backend);
    await signIn(session, visited);
    const client = createMailClient({
      sessionUrl: CONFIG.sessionUrl,
      session,
      fetch: backend.fetch,
    });
    backend.state.accepted.clear();

    const mailboxes = await client.call('Mailbox/get', { ids: null });
    expect(mailboxes.list.length).toBeGreaterThan(0);
    expect(backend.state.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
    });
    expect(session.isSignedIn).toBe(true);
  });

  it('signs out here when the server no longer accepts the user', async () => {
    const backend = await fakeBackend();
    let refusing = false;
    const fetcher = (async (input, init) =>
      refusing && String(input) === CONFIG.tokenUrl
        ? new Response('{}', { status: 400 })
        : backend.fetch(input, init)) as typeof fetch;
    const { session, visited } = testSession({ ...backend, fetch: fetcher });
    await signIn(session, visited);
    const client = createMailClient({
      sessionUrl: CONFIG.sessionUrl,
      session,
      fetch: fetcher,
    });
    // Neither the token nor a new one is to be had.
    refusing = true;
    backend.state.accepted.clear();

    await expect(client.session()).rejects.toMatchObject({ status: 401 });
    expect(session.isSignedIn).toBe(false);
  });

  it('keeps to the site the page came from when told to', async () => {
    const backend = await fakeBackend();
    const { session, visited } = testSession(backend);
    await signIn(session, visited);
    const asked: string[] = [];
    const client = createMailClient({
      sessionUrl: 'http://localhost:5174/.well-known/jmap',
      session,
      sameOrigin: 'http://localhost:5174',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        asked.push(url.origin);
        return backend.fetch(
          `https://mail.example.com${url.pathname}${url.search}`,
          init,
        );
      },
    });
    // The server names mail.example.com as where to call; the calls go to the page's own site all the same.
    await client.call('Mailbox/get', { ids: null });
    expect(new Set(asked)).toEqual(new Set(['http://localhost:5174']));
  });
});
