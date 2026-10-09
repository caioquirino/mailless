import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@mailless/ui';
import { fakeBackend, fakeBrowser, renderApp } from '../test-support';

const sidebar = () => screen.getByRole('navigation', { name: 'Mailboxes' });
const list = (name: string | RegExp) => screen.getByRole('region', { name });
const reader = () => screen.getByRole('region', { name: 'Conversation' });

describe('the webmail', () => {
  it('asks whoever is not signed in to sign in, and shows no mail', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Secret plans' });
    const { visited } = await renderApp(backend, '/', { signedIn: false });

    expect(screen.queryByText('Secret plans')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(visited).toHaveLength(1));
    expect(visited[0]).toContain('client_id=webmail-client');
    expect(visited[0]).toContain(
      encodeURIComponent('https://mail.example.com/mail/callback'),
    );
    expect(backend.state.posts).toBe(0);
  });

  it('opens on the inbox: its conversations, newest first, and what is unread', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Plans',
      from: 'Bob <bob@example.com>',
      text: 'Shall we meet?',
    });
    await backend.deliver({ subject: 'Old news', seen: true });
    await backend.deliver({
      subject: 'Re: Plans',
      from: 'Carol <carol@example.com>',
      inReplyTo: '<m1@example.com>',
      references: '<m1@example.com>',
    });
    await renderApp(backend);

    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    const rows = await within(inbox).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // One row for the conversation, with everyone in it and how many messages.
    expect(rows[0]).toHaveTextContent('Bob, Carol');
    expect(
      within(rows[0] as HTMLElement).getByLabelText('2 messages'),
    ).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Re: Plans');
    expect(
      within(rows[0] as HTMLElement).getByText('Unread'),
    ).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Old news');
    expect(
      within(rows[1] as HTMLElement).queryByText('Unread'),
    ).not.toBeInTheDocument();
    expect(within(inbox).getByText('2 conversations')).toBeInTheDocument();

    expect(within(sidebar()).getByLabelText('2 unread')).toBeInTheDocument();
    expect(
      within(sidebar()).getByRole('link', { name: /Trash/ }),
    ).toBeInTheDocument();
    expect(document.title).toBe('(2) mailless');
  });

  it('reads a conversation, which marks it read', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Plans',
      from: 'Bob <bob@example.com>',
      text: 'Shall we meet at https://example.com/place on Thursday?',
    });
    await renderApp(backend);

    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    const message = await within(reader()).findByRole('article', {
      name: 'Message from Bob',
    });
    expect(
      await within(message).findByText(/Shall we meet at/),
    ).toBeInTheDocument();
    expect(
      within(message).getByRole('link', { name: 'https://example.com/place' }),
    ).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      within(message).getByText(/To: Bob <bob@example.com>/),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        within(sidebar()).queryByLabelText('1 unread'),
      ).not.toBeInTheDocument(),
    );
    expect(document.title).toBe('mailless');
  });

  it('tucks away the middle of a long conversation, behind a count', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Plans',
      from: 'Ann <a@example.com>',
      seen: true,
    });
    for (const name of ['Bo', 'Cy', 'Di', 'Ed', 'Flo']) {
      await backend.deliver({
        subject: 'Re: Plans',
        from: `${name} <${name.toLowerCase()}@example.com>`,
        text: `Words from ${name}`,
        inReplyTo: '<m1@example.com>',
        references: '<m1@example.com>',
        seen: true,
      });
    }
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));

    // How it began, the one before the last, and the last, which is open.
    const last = await within(reader()).findByRole('article', {
      name: 'Message from Flo',
    });
    expect(await within(last).findByText('Words from Flo')).toBeInTheDocument();
    const shown = () =>
      within(reader())
        .getAllByRole('article')
        .map((article) => article.getAttribute('aria-label'));
    expect(shown()).toEqual([
      'Message from Ann',
      'Message from Ed',
      'Message from Flo',
    ]);
    // The others are closed and say only who wrote and how they began.
    expect(
      within(reader()).getByRole('button', { name: /Ed.*Words from Ed/ }),
    ).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Show 3 earlier messages' }),
    );
    expect(shown()).toHaveLength(6);
    expect(
      within(reader()).queryByRole('button', { name: /earlier messages/ }),
    ).not.toBeInTheDocument();
  });

  it('shows a message written in HTML in a frame where nothing runs', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Offer',
      html: '<p>Buy <b>now</b></p><script>steal()</script><img src="https://tracker.example/o.gif">',
      htmlOnly: true,
    });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Offer/ }));

    const frame = (await within(reader()).findByTitle(
      'Message',
    )) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-scripts/);
    const page = frame.getAttribute('srcdoc') as string;
    expect(page).toContain('<b>now</b>');
    expect(page).not.toContain('steal()');
    expect(page).toContain('img-src data:;');

    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Show pictures' }),
    );
    expect(
      (
        within(reader()).getByTitle('Message') as HTMLIFrameElement
      ).getAttribute('srcdoc'),
    ).toContain('img-src data: https: http:;');
    expect(
      within(reader()).queryByRole('button', { name: 'Show pictures' }),
    ).not.toBeInTheDocument();
  });

  it('deletes the conversation being read and goes back to the list', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    await within(reader()).findByRole('article');

    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByText('Moved to the trash')).toBeInTheDocument();
    expect(
      await within(list('Inbox')).findByText('There is nothing here.'),
    ).toBeInTheDocument();
    // Back to the list, which has the whole width again.
    expect(
      screen.queryByRole('region', { name: 'Conversation' }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Trash/ }),
    );
    expect(await within(list('Trash')).findByText('Plans')).toBeInTheDocument();
  });

  it('acts on several conversations at once', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'One' });
    await backend.deliver({ subject: 'Two' });
    await backend.deliver({ subject: 'Three' });
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    await within(inbox).findByText('Three');

    await userEvent.click(within(inbox).getByLabelText('Select One'));
    await userEvent.click(within(inbox).getByLabelText('Select Two'));
    expect(within(inbox).getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(
      within(inbox).getByRole('button', { name: 'Mark read' }),
    );
    await waitFor(() =>
      expect(within(sidebar()).getByLabelText('1 unread')).toBeInTheDocument(),
    );

    await userEvent.click(within(inbox).getByLabelText('Select One'));
    await userEvent.click(within(inbox).getByLabelText('Select Two'));
    await userEvent.click(
      within(inbox).getByRole('button', { name: 'Archive' }),
    );
    expect(await screen.findByText('2 archived')).toBeInTheDocument();
    expect(within(inbox).queryByText('One')).not.toBeInTheDocument();
    expect(within(inbox).getByText('Three')).toBeInTheDocument();

    await userEvent.click(within(inbox).getByLabelText('Select Three'));
    await userEvent.selectOptions(
      within(inbox).getByLabelText('Move to'),
      'Junk',
    );
    expect(await screen.findByText('Moved to Junk')).toBeInTheDocument();
    expect(
      await within(inbox).findByText('There is nothing here.'),
    ).toBeInTheDocument();
  });

  it('acts on one conversation straight from its row, in the wide list', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'One' });
    await backend.deliver({ subject: 'Two' });
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    await within(inbox).findByText('Two');

    await userEvent.click(
      within(inbox).getByRole('button', { name: 'Mark read: One' }),
    );
    expect(
      await within(inbox).findByRole('button', { name: 'Mark unread: One' }),
    ).toBeInTheDocument();
    expect(within(sidebar()).getByLabelText('1 unread')).toBeInTheDocument();

    await userEvent.click(
      within(inbox).getByRole('button', { name: 'Archive: Two' }),
    );
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(within(inbox).queryByText('Two')).not.toBeInTheDocument();

    await userEvent.click(
      within(inbox).getByRole('button', { name: 'Delete: One' }),
    );
    expect(await screen.findByText('Moved to the trash')).toBeInTheDocument();
    expect(
      await within(inbox).findByText('There is nothing here.'),
    ).toBeInTheDocument();
  });

  it('names what is attached, in the wide list, and opens it when pressed', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Menu',
      attachment: {
        name: 'menu.pdf',
        type: 'application/pdf',
        base64: 'JVBERg==',
      },
    });
    await backend.deliver({
      subject: 'A page',
      attachment: {
        name: 'page.html',
        type: 'text/html',
        base64: 'PGI+aGk8L2I+',
      },
    });
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    await within(inbox).findByText('Menu');

    const made: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          made.push(blob);
          return `blob:made-${made.length}`;
        },
        revokeObjectURL: () => undefined,
      }),
    );
    const tab = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as never);
    const saved = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    // Something that can only be looked at opens in a tab of its own, told nothing of this page.
    await userEvent.click(
      within(inbox).getByRole('button', { name: 'menu.pdf' }),
    );
    await waitFor(() =>
      expect(tab.location.replace).toHaveBeenCalledWith('blob:made-1'),
    );
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(made[0]?.type).toBe('application/pdf');
    expect(saved).not.toHaveBeenCalled();

    // A web page could run something: it is saved, never opened.
    await userEvent.click(
      within(inbox).getByRole('button', { name: 'page.html' }),
    );
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledTimes(1);
    expect(made[1]?.type).toBe('application/octet-stream');
    vi.restoreAllMocks();

    // Beside an open conversation there is no room for names: a paperclip says there is something.
    await userEvent.click(within(inbox).getByRole('link', { name: /Menu/ }));
    expect(within(inbox).queryByLabelText('Attached')).not.toBeInTheDocument();
    expect(
      (await within(inbox).findAllByLabelText('Has an attachment')).length,
    ).toBe(2);
  });

  it('empties the trash, after asking', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Gone', mailbox: 'trash' });
    await backend.deliver({ subject: 'Gone too', mailbox: 'trash' });
    await renderApp(backend);
    await userEvent.click(
      await within(
        await screen.findByRole('navigation', { name: 'Mailboxes' }),
      ).findByRole('link', { name: /Trash/ }),
    );
    const trash = await screen.findByRole('region', { name: 'Trash' });
    await within(trash).findByText('Gone');

    await userEvent.click(within(trash).getByRole('button', { name: 'Empty' }));
    const asking = within(trash).getByRole('alertdialog', {
      name: 'Empty Trash',
    });
    await userEvent.click(
      within(asking).getByRole('button', { name: 'Delete everything' }),
    );
    expect(await screen.findByText('2 messages deleted')).toBeInTheDocument();
    expect(
      await within(trash).findByText('There is nothing here.'),
    ).toBeInTheDocument();
    expect(
      within(trash).queryByRole('button', { name: 'Empty' }),
    ).not.toBeInTheDocument();
  });

  it('writes and sends a message', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = screen.getByRole('dialog', { name: 'Write a message' });

    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Say who the message is for.',
    );

    await userEvent.type(
      within(form).getByLabelText('To'),
      'bob@example.com, carol',
    );
    await userEvent.type(within(form).getByLabelText('Subject'), 'Lunch');
    await userEvent.type(within(form).getByLabelText('Message'), 'Thursday?');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      '“carol” in To is not an address.',
    );
    expect(backend.sent).toHaveLength(0);

    await userEvent.type(within(form).getByLabelText('To'), '@example.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(backend.sent[0]?.recipients).toEqual([
      'bob@example.com',
      'carol@example.com',
    ]);
    expect(backend.sent[0]?.message).toContain('Subject: Lunch');
    expect(backend.sent[0]?.message).toContain('Thursday?');

    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Sent/ }),
    );
    const sent = await screen.findByRole('region', { name: 'Sent' });
    expect(await within(sent).findByText('Lunch')).toBeInTheDocument();
    expect(
      within(sent).getByText('To: bob@example.com, carol@example.com'),
    ).toBeInTheDocument();
  });

  it('answers a message, quoting it', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Lunch?',
      from: 'Bob <bob@example.com>',
      to: 'Ann <ann@example.com>',
      text: 'Thursday?',
    });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Lunch\?/ }));
    await userEvent.click(
      await within(reader()).findByRole('button', { name: 'Reply' }),
    );

    const form = screen.getByRole('dialog', { name: 'Write a message' });
    expect(within(form).getByLabelText('To')).toHaveValue(
      'Bob <bob@example.com>',
    );
    expect(within(form).getByLabelText('Subject')).toHaveValue('Re: Lunch?');
    const text = within(form).getByLabelText('Message') as HTMLTextAreaElement;
    expect(text.value).toContain('Bob wrote:\n> Thursday?');
    await userEvent.type(text, 'Yes!', {
      initialSelectionStart: 0,
      initialSelectionEnd: 0,
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(backend.sent[0]?.message).toMatch(
      /^In-Reply-To: <m1@example\.com>/m,
    );
    expect(backend.sent[0]?.message).toContain('Yes!');
    // What was sent joins the conversation being read.
    expect(
      await within(reader()).findByRole('article', {
        name: 'Message from Ann',
      }),
    ).toBeInTheDocument();
  });

  it('keeps a draft when closing, to go on with later', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = screen.getByRole('dialog', { name: 'Write a message' });
    await userEvent.type(
      within(form).getByLabelText('Subject'),
      'Half an idea',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Close' }));
    await userEvent.click(
      within(within(form).getByRole('alertdialog')).getByRole('button', {
        name: 'Keep as a draft',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(
      await within(sidebar()).findByLabelText('1 drafts'),
    ).toBeInTheDocument();

    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Drafts/ }),
    );
    await userEvent.click(
      await screen.findByRole('link', { name: /Half an idea/ }),
    );
    await userEvent.click(
      await within(reader()).findByRole('button', { name: 'Go on writing' }),
    );
    expect(
      within(
        screen.getByRole('dialog', { name: 'Write a message' }),
      ).getByLabelText('Subject'),
    ).toHaveValue('Half an idea');
  });

  it('finds mail by what it says', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Invoice 42', text: 'Amount due' });
    await backend.deliver({ subject: 'Hello' });
    await renderApp(backend);
    await screen.findByRole('region', { name: 'Inbox' });

    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search mail' }),
      'invoice{Enter}',
    );
    const found = await screen.findByRole('region', {
      name: 'Search: invoice',
    });
    expect(await within(found).findByText('Invoice 42')).toBeInTheDocument();
    expect(within(found).queryByText('Hello')).not.toBeInTheDocument();

    await userEvent.click(
      within(found).getByRole('link', { name: /Invoice 42/ }),
    );
    expect(await within(reader()).findByText('Amount due')).toBeInTheDocument();
  });

  it('makes a mailbox and shows it', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(
      await screen.findByRole('button', { name: 'New mailbox' }),
    );
    await userEvent.type(
      screen.getByLabelText('Name of the new mailbox'),
      'Projects{Enter}',
    );
    expect(
      await screen.findByRole('region', { name: 'Projects' }),
    ).toBeInTheDocument();
    expect(
      within(sidebar()).getByRole('link', { name: 'Projects' }),
    ).toBeInTheDocument();
  });

  it('shows what arrives while the page is open, when it is looked at again', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    await within(inbox).findByText('There is nothing here.');

    await backend.deliver({ subject: 'Just in' });
    window.dispatchEvent(new Event('focus'));
    expect(await within(inbox).findByText('Just in')).toBeInTheDocument();
  });

  it('turns notifications on when asked, and then says who wrote', async () => {
    const backend = await fakeBackend();
    const browser = fakeBrowser(backend);
    await renderApp(backend, '/settings', { push: browser.deps });
    const settings = await screen.findByRole('region', { name: 'Settings' });
    // Nobody is asked anything until they press it.
    expect(
      await within(settings).findByText('Off for this browser.'),
    ).toBeInTheDocument();
    expect(browser.state.asked).toBe(0);
    await userEvent.click(
      within(settings).getByRole('button', { name: 'Turn notifications on' }),
    );
    expect(
      await within(settings).findByText('On for this browser.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Notifications are on for this browser'),
    ).toBeInTheDocument();
    expect(browser.state.subscribed).toBe(true);

    // Mail arrives while the page is open and not being looked at: it says who wrote.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await backend.deliver({ subject: 'Lunch?', from: 'Bob <bob@example.com>' });
    const said = await new Promise<unknown>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        channel.port1.close();
        resolve(event.data);
      };
      browser.deliver({ type: 'mailless-state-change' }, [channel.port2]);
    });
    expect(said).toMatchObject({ title: expect.any(String) });
    expect(
      await within(sidebar()).findByLabelText('1 unread'),
    ).toBeInTheDocument();
  });

  it('says so when the browser has been told not to notify', async () => {
    const backend = await fakeBackend();
    const browser = fakeBrowser(backend);
    browser.state.permission = 'denied';
    await renderApp(backend, '/settings', { push: browser.deps });
    expect(
      await screen.findByText(/Notifications are blocked for this site/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Turn notifications/ }),
    ).not.toBeInTheDocument();
  });

  it('says so where there is nothing to notify with', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    expect(
      await screen.findByText(/This browser cannot show notifications/),
    ).toBeInTheDocument();
  });

  it('stops notifying a browser that is signed out of', async () => {
    const backend = await fakeBackend();
    const browser = fakeBrowser(backend);
    const { session } = await renderApp(backend, '/settings', {
      push: browser.deps,
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Turn notifications on' }),
    );
    await screen.findByText('On for this browser.');

    await userEvent.click(screen.getByRole('button', { name: 'Account: Ann' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(session.isSignedIn).toBe(false));
    expect(browser.state.subscribed).toBe(false);
    expect(window.localStorage.getItem('mailless.mail.push')).toBeNull();
  });

  it('shows who is signed in and how full their mailbox is, behind their picture', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Hello' });
    await renderApp(backend);
    const button = await screen.findByRole('button', { name: 'Account: Ann' });
    expect(
      screen.queryByRole('dialog', { name: 'Account' }),
    ).not.toBeInTheDocument();

    await userEvent.click(button);
    const card = screen.getByRole('dialog', { name: 'Account' });
    expect(within(card).getByText('Ann')).toBeInTheDocument();
    expect(within(card).getByText('ann@example.com')).toBeInTheDocument();
    expect(
      await within(card).findByText(/ of 1\.0 GB used$/),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole('link', { name: /Password, passkeys/ }),
    ).toHaveAttribute('href', '/admin/');
    expect(
      within(card).getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: 'Account' }),
    ).not.toBeInTheDocument();
  });

  it('has settings: how it looks, whether it notifies, and where the password is', async () => {
    const backend = await fakeBackend();
    const browser = fakeBrowser(backend);
    const theme = new Theme({
      storage: window.localStorage,
      root: document.documentElement,
    });
    await renderApp(backend, '/', { theme, push: browser.deps });
    await userEvent.click(
      await screen.findByRole('link', { name: 'Settings' }),
    );
    const settings = await screen.findByRole('region', { name: 'Settings' });

    expect(within(settings).getByLabelText(/Same as the system/)).toBeChecked();
    await userEvent.click(within(settings).getByLabelText(/^Dark/));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await userEvent.click(
      within(settings).getByLabelText(/Same as the system/),
    );
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(window.localStorage.getItem('mailless.theme')).toBeNull();

    expect(
      within(settings).getByText('Off for this browser.'),
    ).toBeInTheDocument();
    await userEvent.click(
      within(settings).getByRole('button', { name: 'Turn notifications on' }),
    );
    expect(
      await within(settings).findByText('On for this browser.'),
    ).toBeInTheDocument();
    expect(within(settings).getByText('ann@example.com')).toBeInTheDocument();
    expect(
      within(settings).getByRole('link', { name: /Password, passkeys/ }),
    ).toHaveAttribute('href', '/admin/');
  });

  it('keeps a name and a signature for an address, and signs what is written with it', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    const form = await screen.findByRole('form', { name: 'ann@example.com' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Ann');
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.type(
      within(form).getByLabelText('Signature'),
      'Ann Lee{Enter}Example Ltd',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Write' }));
    const message = within(
      screen.getByRole('dialog', { name: 'Write a message' }),
    ).getByLabelText('Message') as HTMLTextAreaElement;
    expect(message.value).toBe('\n\n-- \nAnn Lee\nExample Ltd');
    await userEvent.type(
      within(screen.getByRole('dialog')).getByLabelText('To'),
      'bob@example.com',
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Send' }),
    );
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(backend.sent[0]?.message).toContain('-- \r\nAnn Lee\r\nExample Ltd');
  });

  it('gives the list the whole width until a conversation is opened, then shares it where the divider is left', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    expect(inbox).toHaveClass('list-wide');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    expect(inbox).not.toHaveClass('list-wide');
    const divider = await screen.findByRole('separator', {
      name: 'Width of the list',
    });
    expect(divider).toHaveAttribute('aria-valuenow', '400');
    divider.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowLeft}');
    expect(divider).toHaveAttribute('aria-valuenow', '424');
    // Remembered for the next conversation, and the next visit.
    expect(window.localStorage.getItem('mailless.mail.list-width')).toBe('424');

    await userEvent.click(
      within(reader()).getByRole('link', { name: 'Back to Inbox' }),
    );
    expect(await screen.findByRole('region', { name: 'Inbox' })).toHaveClass(
      'list-wide',
    );
  });

  it('folds the mailboxes down to their icons, and remembers that', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    const side = (await screen.findByRole('navigation', { name: 'Mailboxes' }))
      .parentElement as HTMLElement;
    expect(side).not.toHaveClass('side-folded');

    await userEvent.click(screen.getByRole('button', { name: 'Mailboxes' }));
    expect(side).toHaveClass('side-folded');
    expect(window.localStorage.getItem('mailless.mail.sidebar-folded')).toBe(
      'true',
    );
    // Folded, each still says what it is and that something is unread in it.
    expect(
      within(sidebar()).getByRole('link', { name: /Inbox/ }),
    ).toHaveAttribute('title', 'Inbox');
    expect(within(sidebar()).getByLabelText('1 unread')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mailboxes' }));
    expect(side).not.toHaveClass('side-folded');
  });

  it('signs out here and at the provider', async () => {
    const backend = await fakeBackend();
    const { session, visited } = await renderApp(backend);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Account: Ann' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(session.isSignedIn).toBe(false));
    expect(visited.at(-1)).toContain('https://auth.example.com/logout');
    expect(
      await screen.findByRole('button', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });
});
