import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBackend, renderApp } from '../test-support';

const SECRET = 'mlapp-aaaaa-bbbbb-ccccc';

describe('signing in', () => {
  it('shows the sign-in page to someone who is not signed in, and starts sign-in from it', async () => {
    const { visited } = await renderApp(fakeBackend(), '/', {
      signedIn: false,
    });
    expect(
      screen.getByRole('heading', { name: 'mailless admin' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('My account')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(visited).toHaveLength(1));
    expect(visited[0]).toContain('https://auth.example.com/oauth2/authorize?');
  });

  it('finishes sign-in on the way back from the provider and shows the account', async () => {
    const backend = fakeBackend();
    // A sign-in was started in this browser before it left for the provider.
    const first = await renderApp(backend, '/', { signedIn: false });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(first.visited).toHaveLength(1));
    const state = new URL(first.visited[0] as string).searchParams.get('state');
    first.unmount();

    const { session } = await renderApp(
      backend,
      `/callback?code=code-1&state=${state}`,
      { signedIn: false },
    );
    expect(
      await screen.findByRole('heading', { name: 'My account' }),
    ).toBeInTheDocument();
    expect(session.isSignedIn).toBe(true);
    // Kept for this tab only: never where another tab or a later visit could find it.
    expect(
      JSON.stringify([{ ...window.localStorage }, document.cookie]),
    ).not.toMatch(/access-1|refresh-1/);
  });

  it('explains a sign-in that failed and offers another try', async () => {
    const backend = fakeBackend();
    await renderApp(backend, '/callback?code=code-1&state=made-up', {
      signedIn: false,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sign-in was not started from this page. Please sign in again.',
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(backend.state.tokenRequests).toEqual([]);
  });

  it('shows what the provider said when the exchange is refused', async () => {
    const backend = fakeBackend();
    const first = await renderApp(backend, '/', { signedIn: false });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(first.visited).toHaveLength(1));
    const state = new URL(first.visited[0] as string).searchParams.get('state');
    first.unmount();
    backend.state.nextAccessToken = null;

    await renderApp(backend, `/callback?code=code-1&state=${state}`, {
      signedIn: false,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in could not be completed. Please try again.',
    );
  });

  it('comes back from adding a passkey to the account page, still signed in', async () => {
    await renderApp(fakeBackend(), '/callback');
    expect(
      await screen.findByRole('heading', { name: 'My account' }),
    ).toBeInTheDocument();
  });

  it('signs out at the provider too', async () => {
    const { visited, session } = await renderApp(fakeBackend(), '/');
    await screen.findByRole('heading', { name: 'My account' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(session.isSignedIn).toBe(false);
    expect(visited.at(-1)).toContain('https://auth.example.com/logout?');
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });
});

describe('my account', () => {
  it('shows who is signed in, with their addresses', async () => {
    await renderApp(fakeBackend(), '/');
    const section = (
      await screen.findByRole('heading', { name: 'Signed in as' })
    ).closest('section') as HTMLElement;
    expect(within(section).getByText('ann')).toBeInTheDocument();
    expect(within(section).getByText('ann@example.com')).toBeInTheDocument();
    expect(within(section).getByText('User')).toBeInTheDocument();
    // Not an administrator: nothing leads to the accounts.
    expect(
      screen.queryByRole('link', { name: 'Accounts' }),
    ).not.toBeInTheDocument();
  });

  it('changes the password, and shows the API’s refusals', async () => {
    const backend = fakeBackend();
    await renderApp(backend, '/');
    const user = userEvent.setup();
    const fill = async (current: string, next: string, again = next) => {
      for (const [label, value] of [
        ['Current password', current],
        ['New password', next],
        ['New password, again', again],
      ] as const) {
        const input = await screen.findByLabelText(label);
        await user.clear(input);
        await user.type(input, value);
      }
      await user.click(screen.getByRole('button', { name: 'Change password' }));
    };

    await fill('the current password', 'a new long passphrase', 'different');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The two new passwords are not the same.',
    );
    expect(backend.state.calls.some((c) => c.path === '/me/password')).toBe(
      false,
    );

    await fill('wrong', 'a new long passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The current password is not right',
    );
    await fill('the current password', 'short');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A password has at least 14 characters',
    );

    await fill('the current password', 'a new long passphrase');
    expect(
      await screen.findByText('Your password was changed.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it('shows a new app password once, and nothing of it after', async () => {
    const backend = fakeBackend();
    const { container } = await renderApp(backend, '/');
    const user = userEvent.setup();
    await screen.findByText('You have no app passwords.');

    await user.type(
      screen.getByLabelText('Where will you use it?'),
      'Phone mail app',
    );
    await user.click(
      screen.getByRole('button', { name: 'Create app password' }),
    );

    const box = await screen.findByRole('group', { name: 'New app password' });
    expect(within(box).getByText(SECRET)).toBeInTheDocument();
    expect(box).toHaveTextContent('It is shown only this once.');
    expect(box).toHaveTextContent('sign in with your email address');
    // It is in the list now, by its label and without its secret.
    const row = (await screen.findByText('Phone mail app')).closest(
      'li',
    ) as HTMLElement;
    expect(row).toHaveTextContent('Last used never');
    expect(row).not.toHaveTextContent(SECRET);

    await user.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(
      screen.queryByRole('group', { name: 'New app password' }),
    ).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(SECRET);
    expect(screen.getByText('Phone mail app')).toBeInTheDocument();
    // Nor was it ever part of an address, or kept by the browser.
    expect(
      JSON.stringify(backend.state.calls.map((c) => c.path)),
    ).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
  });

  it('revokes an app password after asking', async () => {
    const backend = fakeBackend();
    backend.state.appPasswords.push({
      id: 'ap9',
      label: 'Old laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    });
    await renderApp(backend, '/');
    const user = userEvent.setup();
    const row = (await screen.findByText('Old laptop')).closest(
      'li',
    ) as HTMLElement;
    expect(row).toHaveTextContent('Last used never');

    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    // Asking is not doing.
    expect(backend.state.appPasswords).toHaveLength(1);
    await user.click(
      screen.getByRole('button', { name: 'Revoke app password' }),
    );
    expect(
      await screen.findByText('The app password was revoked.'),
    ).toBeInTheDocument();
    expect(backend.state.calls.at(-2)).toMatchObject({
      method: 'DELETE',
      path: '/me/app-passwords/ap9',
    });
    expect(screen.queryByText('Old laptop')).not.toBeInTheDocument();
  });

  it('lists passkeys, removes one after asking, and leads to where one is added', async () => {
    const backend = fakeBackend();
    backend.state.passkeys.push({
      id: 'pk1',
      name: 'Phone',
      createdAt: '2026-03-04T05:06:07.000Z',
    });
    const { visited } = await renderApp(backend, '/');
    const user = userEvent.setup();
    const row = (await screen.findByText('Phone')).closest('li') as HTMLElement;

    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(backend.state.passkeys).toHaveLength(1);
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Remove passkey' }));
    expect(
      await screen.findByText('You have no passkeys.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add a passkey' }));
    expect(visited.at(-1)).toContain('https://auth.example.com/passkeys/add?');
  });

  it('sets up an authenticator app: the secret to scan or type, then a code from it', async () => {
    const backend = fakeBackend();
    await renderApp(backend, '/');
    const user = userEvent.setup();
    const section = (
      await screen.findByRole('heading', { name: 'Authenticator app' })
    ).closest('section') as HTMLElement;
    expect(
      await within(section).findByText(/No code is asked for/),
    ).toBeInTheDocument();

    await user.click(
      within(section).getByRole('button', { name: 'Set up an authenticator' }),
    );
    // In fours, as it is easiest to type; and as a picture to scan.
    expect(
      await within(section).findByText(
        'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP',
      ),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole('img', {
        name: 'Code to scan with the authenticator app',
      }),
    ).toBeInTheDocument();

    const code = within(section).getByLabelText('Code from the app');
    await user.type(code, '000000');
    await user.click(within(section).getByRole('button', { name: 'Turn on' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'The code is not the one the authenticator app shows now',
    );
    expect(backend.state.authenticator).toBe(false);

    await user.clear(code);
    await user.type(code, '123 456');
    await user.click(within(section).getByRole('button', { name: 'Turn on' }));
    expect(
      await within(section).findByText(
        /A code from your authenticator app is asked for/,
      ),
    ).toBeInTheDocument();
    expect(backend.state.authenticator).toBe(true);
    // The secret is not kept on the page once it has done its work.
    expect(within(section).queryByText(/JBSW/)).not.toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Turn off' }));
    await user.click(
      screen.getByRole('button', { name: 'Stop asking for a code' }),
    );
    expect(
      await within(section).findByText(/No code is asked for/),
    ).toBeInTheDocument();
    expect(backend.state.authenticator).toBe(false);
  });

  it('offers no app passwords to a user without a mailbox', async () => {
    await renderApp(fakeBackend({ mailbox: false }), '/');
    expect(
      await screen.findByText('You do not have a mailbox here.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Passkeys' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'App passwords' }),
    ).not.toBeInTheDocument();
  });
});

describe('accounts', () => {
  it('keeps them from someone who is not an administrator', async () => {
    const backend = fakeBackend();
    await renderApp(backend, '/accounts');
    expect(
      await screen.findByRole('heading', { name: 'For administrators' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The page did not even ask.
    expect(backend.state.calls.map((call) => call.path)).toEqual(['/me']);
  });

  it('lists them for an administrator', async () => {
    await renderApp(fakeBackend({ username: 'root', isAdmin: true }), '/');
    await userEvent.click(
      await screen.findByRole('link', { name: 'Accounts' }),
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'bob' })).toHaveAttribute(
      'href',
      '/accounts/bob',
    );
    expect(within(table).getByText('Bob B')).toBeInTheDocument();
    expect(within(table).getAllByText('Active')).toHaveLength(2);
  });

  it('creates an account and goes to it, then adds an address', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    await renderApp(backend, '/accounts');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Account id'), 'cat');
    await user.type(screen.getByLabelText('Name (optional)'), 'Cat C');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByRole('heading', { name: /^cat/ }),
    ).toBeInTheDocument();
    expect(
      backend.state.calls.find((call) => call.method === 'POST'),
    ).toMatchObject({ path: '/accounts', body: { id: 'cat', name: 'Cat C' } });
    expect(
      screen.getByText(
        'No address delivers here, so this account gets no mail.',
      ),
    ).toBeInTheDocument();

    await user.type(
      screen.getByLabelText('Add an address'),
      'cat+x@example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Add address' }));
    expect(
      await screen.findByText('The address was added.'),
    ).toBeInTheDocument();
    // The address is one part of the path, "@" and "+" and all.
    expect(
      backend.state.calls.find((call) => call.method === 'PUT'),
    ).toMatchObject({ path: '/accounts/cat/addresses/cat%2Bx%40example.com' });
    expect(await screen.findByText('cat+x@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Add an address')).toHaveValue('');
  });

  it('shows the API’s refusal when an account cannot be created', async () => {
    await renderApp(
      fakeBackend({ username: 'root', isAdmin: true }),
      '/accounts',
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Account id'), 'bob');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The account "bob" already exists',
    );
    expect(
      screen.getByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument();
  });

  it('does not let an administrator lock themself out of their own account', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    await renderApp(backend, '/accounts/root');
    await screen.findByRole('heading', { name: /^root/ });
    for (const name of [
      'Remove administrator role',
      'Disable account',
      'Close account',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(
      screen.getAllByText(
        'This is your own account. Another administrator has to do this.',
      ),
    ).toHaveLength(3);
    // What cannot lock them out stays open to them.
    expect(screen.getByRole('button', { name: 'Set password' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'End all sessions' }),
    ).toBeEnabled();
  });

  it('gives an account a limit of its own, and takes it away again', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    await renderApp(backend, '/accounts/bob');
    const user = userEvent.setup();
    expect(
      await screen.findByText(/accounts without one have no limit/),
    ).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save limit' });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Limit'), '2.5');
    await user.click(save);
    await waitFor(() =>
      expect(backend.state.calls).toContainEqual(
        expect.objectContaining({
          method: 'PATCH',
          path: '/accounts/bob',
          body: { quotaOctets: 2.5 * 1024 * 1024 * 1024 },
        }),
      ),
    );
    expect(
      await screen.findByText(/has a limit of its own: 2\.5 GB/),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Remove its own limit' }),
    );
    await waitFor(() =>
      expect(backend.state.calls).toContainEqual(
        expect.objectContaining({
          method: 'PATCH',
          path: '/accounts/bob',
          body: { quotaOctets: null },
        }),
      ),
    );
  });

  it('closes another account only once its id has been typed', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    await renderApp(backend, '/accounts/bob');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Close account' }),
    );
    const confirm = screen.getByRole('button', {
      name: 'Close account permanently',
    });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type bob to confirm/), 'bo');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type bob to confirm/), 'b');
    await user.click(confirm);
    await waitFor(() =>
      expect(backend.state.calls).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/accounts/bob' }),
      ),
    );
  });

  it('shows a closed account without anything to change', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    (backend.state.accounts.get('bob') as { status: string }).status =
      'deleting';
    await renderApp(backend, '/accounts/bob');
    expect(
      await screen.findByText(/This account is closed\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /Close account|Set password|Add address/,
      }),
    ).not.toBeInTheDocument();
  });

  it('asks again for the mail of a closed account to be removed', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    (backend.state.accounts.get('bob') as { status: string }).status =
      'deleting';
    await renderApp(backend, '/accounts/bob');
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Remove mail again' }));
    await waitFor(() =>
      expect(backend.state.calls).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/accounts/bob' }),
      ),
    );
  });

  it('says so when there is no such account, or no such page', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    const first = await renderApp(backend, '/accounts/nobody');
    expect(
      await screen.findByRole('heading', { name: 'No such account' }),
    ).toBeInTheDocument();
    first.unmount();
    await renderApp(backend, '/somewhere/else');
    expect(
      await screen.findByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument();
  });
});
