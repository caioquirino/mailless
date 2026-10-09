import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@mailless/ui';
import { fakeBackend, fakeBrowser, renderApp } from '../test-support';

const sidebar = () => screen.getByRole('navigation', { name: 'Mailboxes' });
const list = (name: string | RegExp) => screen.getByRole('region', { name });
const reader = () => screen.getByRole('region', { name: 'Conversation' });
/** The window a message is written in. It is fetched when first asked for. */
const writing = () => screen.findByRole('dialog', { name: 'Write a message' });

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

    // Printed, it has the pictures the screen now has.
    await userEvent.click(
      within(reader()).getByRole('button', { name: 'More for this message' }),
    );
    await userEvent.click(
      within(reader()).getByRole('menuitem', { name: 'Print' }),
    );
    const printed = document.querySelector('iframe.print-frame');
    expect(printed?.getAttribute('srcdoc')).toContain(
      'img-src data: https: http:;',
    );
    printed?.remove();
    expect(
      within(reader()).queryByRole('button', { name: 'Show pictures' }),
    ).not.toBeInTheDocument();
  });

  it('acts on one message of a conversation, from the buttons beside it', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Plans',
      from: 'Bob <bob@example.com>',
      text: 'First thoughts',
    });
    await backend.deliver({
      subject: 'Re: Plans',
      from: 'Carol <carol@example.com>',
      text: 'Second thoughts',
      inReplyTo: '<m1@example.com>',
    });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    const carol = await within(reader()).findByRole('article', {
      name: 'Message from Carol',
    });
    await within(carol).findByText('Second thoughts');

    // A flag of its own, apart from the conversation's.
    await userEvent.click(
      within(carol).getByRole('button', { name: 'Star this message' }),
    );
    expect(
      await within(carol).findByRole('button', {
        name: 'Remove the star from this message',
      }),
    ).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(
      within(carol).getByRole('button', { name: 'More for this message' }),
    );
    const menu = within(carol).getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Reply',
      'Forward',
      'Delete this message',
      'Mark unread from here',
      'Report as junk',
      'Report phishing',
      'Add Carol to contacts',
      'Print',
      'Download message',
      'Show original',
    ]);

    // Reported, it goes to the junk, and the rest of the conversation stays open.
    await userEvent.click(
      within(menu).getByRole('menuitem', { name: 'Report phishing' }),
    );
    expect(
      await screen.findByText('Reported as phishing, and moved to Junk'),
    ).toBeInTheDocument();
    expect(
      within(reader()).getByRole('article', { name: 'Message from Bob' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Junk/ }),
    );
    expect(
      await within(
        await screen.findByRole('region', { name: 'Junk' }),
      ).findByText('Re: Plans'),
    ).toBeInTheDocument();
  });

  it('leaves a message thrown away out of its conversation, and shows it alone in the trash', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Plans',
      from: 'Bob <bob@example.com>',
      text: 'First thoughts',
    });
    await backend.deliver({
      subject: 'Re: Plans',
      from: 'Carol <carol@example.com>',
      text: 'Second thoughts',
      inReplyTo: '<m1@example.com>',
    });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    const carol = await within(reader()).findByRole('article', {
      name: 'Message from Carol',
    });
    await userEvent.click(
      within(carol).getByRole('button', { name: 'More for this message' }),
    );
    await userEvent.click(
      within(carol).getByRole('menuitem', { name: 'Delete this message' }),
    );

    // Gone from what is being read, and from the count on its line in the list.
    await waitFor(() =>
      expect(
        within(reader()).queryByRole('article', { name: 'Message from Carol' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(reader()).getByRole('article', { name: 'Message from Bob' }),
    ).toBeInTheDocument();
    expect(
      within(list('Inbox')).queryByLabelText('2 messages'),
    ).not.toBeInTheDocument();

    // In the trash it is by itself: the rest of the conversation was not thrown away.
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Trash/ }),
    );
    await userEvent.click(
      await within(list('Trash')).findByRole('link', { name: /Plans/ }),
    );
    expect(
      await within(reader()).findByRole('article', {
        name: 'Message from Carol',
      }),
    ).toBeInTheDocument();
    expect(
      within(reader()).queryByRole('article', { name: 'Message from Bob' }),
    ).not.toBeInTheDocument();

    // Put back where it was, it is part of its conversation again.
    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Move back to Inbox' }),
    );
    expect(await screen.findByText('Moved back to Inbox')).toBeInTheDocument();
    expect(
      await within(list('Trash')).findByText('There is nothing here.'),
    ).toBeInTheDocument();
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Inbox/ }),
    );
    expect(
      await within(list('Inbox')).findByLabelText('2 messages'),
    ).toBeInTheDocument();
  });

  it('puts what was thrown away back in the mailbox it came from, not always the inbox', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    const pick = async (region: HTMLElement) =>
      userEvent.click(
        await within(region).findByRole('checkbox', { name: /Select Plans/ }),
      );

    await pick(inbox);
    await userEvent.click(
      within(inbox).getByRole('button', { name: 'Archive' }),
    );
    await screen.findByText('Archived');
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Archive/ }),
    );
    await pick(list('Archive'));
    await userEvent.click(
      within(list('Archive')).getByRole('button', { name: 'Delete' }),
    );
    await screen.findByText('Moved to the trash');

    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Trash/ }),
    );
    await pick(list('Trash'));
    await userEvent.click(
      within(list('Trash')).getByRole('button', {
        name: 'Move back to Archive',
      }),
    );
    expect(
      await screen.findByText('Moved back to Archive'),
    ).toBeInTheDocument();
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Archive/ }),
    );
    expect(
      await within(list('Archive')).findByText('Plans'),
    ).toBeInTheDocument();
  });

  it('marks a conversation unread from one message on, and prints one by itself', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans', from: 'Bob <bob@example.com>' });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    const bob = await within(reader()).findByRole('article', {
      name: 'Message from Bob',
    });
    const more = await within(bob).findByRole('button', {
      name: 'More for this message',
    });

    await userEvent.click(more);
    await userEvent.click(within(bob).getByRole('menuitem', { name: 'Print' }));
    const frame = document.querySelector('iframe.print-frame');
    // Somebody else's page, printed from a frame where no script runs.
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-modals');
    expect(frame?.getAttribute('srcdoc')).toContain('<b>From:</b> Bob');
    // Nothing is fetched from the sender for it that the screen is not showing.
    expect(frame?.getAttribute('srcdoc')).toContain('img-src data:;');
    frame?.remove();

    await userEvent.click(more);
    await userEvent.click(
      within(bob).getByRole('menuitem', { name: 'Mark unread from here' }),
    );
    expect(await screen.findByText('Marked unread')).toBeInTheDocument();
    expect(
      await within(sidebar()).findByLabelText('1 unread'),
    ).toBeInTheDocument();
  });

  it('gives a conversation the whole page when asked, and remembers that', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans' });
    await backend.deliver({ subject: 'Other news' });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    await within(reader()).findByRole('article');
    expect(reader()).not.toHaveClass('reader-alone');

    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Read on the whole page' }),
    );
    expect(reader()).toHaveClass('reader-alone');

    // The next one opened is read the same way.
    await userEvent.click(
      within(reader()).getByRole('link', { name: 'Back to Inbox' }),
    );
    await userEvent.click(
      await screen.findByRole('link', { name: /Other news/ }),
    );
    await within(reader()).findByRole('article');
    expect(reader()).toHaveClass('reader-alone');

    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Show the list beside it' }),
    );
    expect(reader()).not.toHaveClass('reader-alone');
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
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Conversation' }),
      ).not.toBeInTheDocument(),
    );

    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Trash/ }),
    );
    expect(await within(list('Trash')).findByText('Plans')).toBeInTheDocument();
  });

  it('takes back what was just done: archived, thrown away or moved, with Undo', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    await within(reader()).findByRole('article');

    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Delete' }),
    );
    await screen.findByText('Moved to the trash');
    expect(
      await within(list('Inbox')).findByText('There is nothing here.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    // Back in the inbox, and not marked as having been anywhere else.
    const row = await within(list('Inbox')).findByRole('checkbox', {
      name: /Select Plans/,
    });
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Trash/ }),
    );
    expect(
      await within(list('Trash')).findByText('There is nothing here.'),
    ).toBeInTheDocument();
    expect(row).toBeDefined();

    // From the list too.
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Inbox/ }),
    );
    await userEvent.click(
      await within(list('Inbox')).findByRole('checkbox', {
        name: /Select Plans/,
      }),
    );
    await userEvent.click(
      within(list('Inbox')).getByRole('button', { name: 'Archive' }),
    );
    await screen.findByText('Archived');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await within(list('Inbox')).findByText('Plans')).toBeInTheDocument();
  });

  it('offers no Undo for what was deleted permanently', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans', mailbox: 'trash' });
    await renderApp(backend);
    await userEvent.click(
      within(
        await screen.findByRole('navigation', { name: 'Mailboxes' }),
      ).getByRole('link', { name: /Trash/ }),
    );
    await userEvent.click(
      await within(list('Trash')).findByRole('link', { name: /Plans/ }),
    );
    await within(reader()).findByRole('article');
    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Delete permanently' }),
    );
    await screen.findByText('Permanently deleted');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
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
    const form = await writing();

    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Say who the message is for.',
    );

    // A comma ends an address, which becomes someone who can be taken out again.
    await userEvent.type(
      within(form).getByLabelText('To'),
      'bob@example.com, carol',
    );
    const people = within(form).getByRole('list', { name: 'To: people' });
    expect(within(people).getByText('bob@example.com')).toBeInTheDocument();
    expect(within(form).getByLabelText('To')).toHaveValue('carol');
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
    // It goes as a page and as plain words, for whichever its reader shows.
    expect(backend.sent[0]?.message).toContain('Subject: Lunch');
    expect(backend.sent[0]?.message).toContain('multipart/alternative');
    expect(backend.sent[0]?.message).toContain('Thursday?');
    expect(backend.sent[0]?.message).toContain(
      '<div class="mailless-words"><p style="margin:0">Thursday?</p></div>',
    );

    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Sent/ }),
    );
    const sent = await screen.findByRole('region', { name: 'Sent' });
    expect(await within(sent).findByText('Lunch')).toBeInTheDocument();
    expect(
      within(sent).getByText('To: bob@example.com, carol@example.com'),
    ).toBeInTheDocument();
  });

  it('suggests who a message might be for, from who was written to before', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    const write = async (to: string) => {
      await userEvent.click(screen.getByRole('button', { name: 'Write' }));
      const form = await writing();
      await userEvent.type(within(form).getByLabelText('To'), to);
      await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
    };
    await screen.findByRole('button', { name: 'Write' });
    await write('Bob Stone <bob@example.com>');
    await write('bella@example.org');

    await userEvent.click(screen.getByRole('button', { name: 'Write' }));
    const form = await writing();
    const to = within(form).getByLabelText('To');
    await userEvent.type(to, 'b');
    const offered = await within(form).findByRole('listbox', {
      name: 'To: suggestions',
    });
    expect(
      within(offered)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Bbella@example.org', 'BBob Stonebob@example.com']);

    // The arrow keys choose, and Enter takes.
    await userEvent.keyboard('{ArrowDown}');
    expect(
      within(offered).getByRole('option', { name: /Bob Stone/ }),
    ).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    const people = within(form).getByRole('list', { name: 'To: people' });
    expect(within(people).getByText('Bob Stone')).toBeInTheDocument();
    expect(to).toHaveValue('');

    // Whoever it is for already is not offered again; pressed, another is taken.
    await userEvent.type(to, 'b');
    const left = within(form).getByRole('listbox', { name: 'To: suggestions' });
    expect(within(left).getAllByRole('option')).toHaveLength(1);
    await userEvent.click(within(left).getByRole('option'));
    expect(within(people).getByText('bella@example.org')).toBeInTheDocument();

    // An address typed out in full is the one meant, whoever else begins like it.
    await userEvent.type(to, 'bo@example.com{Enter}');
    expect(within(people).getByText('bo@example.com')).toBeInTheDocument();
  });

  it('takes people out again, and the last of them with the backspace key', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    const to = within(form).getByLabelText('To');
    await userEvent.type(to, 'Bob <bob@example.com>{Enter}carol@example.com,');
    const people = within(form).getByRole('list', { name: 'To: people' });
    expect(within(people).getByText('Bob')).toBeInTheDocument();
    expect(within(people).getByText('carol@example.com')).toBeInTheDocument();

    await userEvent.click(
      within(people).getByRole('button', { name: 'Remove Bob' }),
    );
    expect(within(people).queryByText('Bob')).not.toBeInTheDocument();
    await userEvent.type(to, '{Backspace}');
    expect(
      within(people).queryByText('carol@example.com'),
    ).not.toBeInTheDocument();
  });

  it('answers a message, with what it answers kept under the words', async () => {
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

    const form = await writing();
    expect(
      within(within(form).getByRole('list', { name: 'To: people' })).getByText(
        'Bob',
      ),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Subject')).toHaveValue('Re: Lunch?');
    // What is answered is not among the words: it is behind a button, as it came.
    expect(within(form).getByLabelText('Message')).toHaveTextContent('');
    await userEvent.click(
      within(form).getByRole('button', { name: 'Show what you are answering' }),
    );
    expect(within(form).getByTitle('what you are answering')).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('Bob wrote:'),
    );

    await userEvent.type(within(form).getByLabelText('Message'), 'Yes!');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    const message = backend.sent[0]?.message ?? '';
    expect(message).toMatch(/^In-Reply-To: <m1@example\.com>/m);
    expect(message).toMatch(/Yes!\r\n\r\nOn .* Bob wrote:\r\n> Thursday\?/);
    expect(message).toMatch(/<blockquote type=(3D)?"cite"/);
    // What was sent joins the conversation being read.
    expect(
      await within(reader()).findByRole('article', {
        name: 'Message from Ann',
      }),
    ).toBeInTheDocument();
  });

  it('answers a message with its pictures still in what is quoted', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      raw: [
        'From: Bob <bob@example.com>',
        'To: Ann <ann@example.com>',
        'Subject: The plan',
        'Message-ID: <plan@example.com>',
        'Date: Mon, 05 Jan 2026 09:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/related; boundary="b"',
        '',
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Here it is</p><img src="cid:plan@example.com">',
        '--b',
        'Content-Type: image/png; name="plan.png"',
        'Content-Disposition: inline; filename="plan.png"',
        'Content-ID: <plan@example.com>',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--b--',
        '',
      ].join('\r\n'),
    });
    await renderApp(backend);
    await userEvent.click(
      await screen.findByRole('link', { name: /The plan/ }),
    );
    await userEvent.click(
      await within(reader()).findByRole('button', { name: 'Reply' }),
    );
    const form = await writing();
    await userEvent.type(within(form).getByLabelText('Message'), 'Thanks');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    const message = (backend.sent[0]?.message ?? '').replace(/=\r\n/g, '');
    // The picture goes along as a part of the answer, and the quote points at it.
    expect(message).toContain('multipart/related');
    expect(message).toMatch(/Content-ID: <plan@example\.com>/i);
    expect(message).toMatch(/<img src=(3D)?"cid:plan@example\.com"/);
  });

  it('keeps a draft when closing, to go on with later', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    await userEvent.type(
      within(form).getByLabelText('Subject'),
      'Half an idea',
    );
    await userEvent.type(within(form).getByLabelText('Message'), 'So far');
    await userEvent.click(within(form).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Draft kept')).toBeInTheDocument();
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
    const again = await writing();
    expect(within(again).getByLabelText('Subject')).toHaveValue('Half an idea');
    expect(within(again).getByLabelText('Message')).toHaveTextContent('So far');

    // Discarded, nothing is left of it.
    await userEvent.click(
      within(again).getByRole('button', { name: 'Discard' }),
    );
    await userEvent.click(
      within(
        within(again).getByRole('alertdialog', { name: 'Discard the message' }),
      ).getByRole('button', { name: 'Discard' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        within(sidebar()).queryByLabelText('1 drafts'),
      ).not.toBeInTheDocument(),
    );
  });

  it('keeps what is written by itself, a moment after the last change', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    await userEvent.type(within(form).getByLabelText('Subject'), 'Slowly');
    expect(within(form).getByRole('status')).toHaveTextContent('');
    expect(
      await within(form).findByText(/^Draft kept at /, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(within(sidebar()).getByLabelText('1 drafts')).toBeInTheDocument();
  });

  it('is one window in three sizes: docked, down to its title, and over the page', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    expect(form).toHaveClass('compose-docked');
    expect(
      within(form).getByRole('heading', { name: 'New message' }),
    ).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Subject'), 'Plans');
    await userEvent.type(within(form).getByLabelText('Message'), 'First,');

    await userEvent.click(
      within(form).getByRole('button', { name: 'Full screen' }),
    );
    expect(form).toHaveClass('compose-full');
    await userEvent.click(
      within(form).getByRole('button', { name: 'Leave full screen' }),
    );
    await userEvent.click(
      within(form).getByRole('button', { name: 'Minimise' }),
    );
    expect(form).toHaveClass('compose-minimised');
    // Its title is what it is about, and nothing written is lost by putting it away.
    expect(
      within(form).getByRole('heading', { name: 'Plans' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(form).getByRole('button', { name: 'Open the window again' }),
    );
    expect(form).toHaveClass('compose-docked');
    expect(within(form).getByLabelText('Message')).toHaveTextContent('First,');
  });

  it('puts emoji in the words, as characters any mail program shows', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    await userEvent.type(within(form).getByLabelText('To'), 'bob@example.com');
    await userEvent.type(within(form).getByLabelText('Message'), 'Well done ');
    await userEvent.click(within(form).getByRole('button', { name: 'Emoji' }));
    const panel = within(form).getByRole('dialog', { name: 'Emoji' });
    await userEvent.type(
      within(panel).getByLabelText('Find an emoji'),
      'party',
    );
    await userEvent.click(
      within(panel).getByRole('button', { name: 'party celebration' }),
    );
    expect(within(form).getByLabelText('Message')).toHaveTextContent(
      'Well done 🎉',
    );
    // What was used is at hand the next time.
    await userEvent.clear(within(panel).getByLabelText('Find an emoji'));
    expect(
      within(
        within(panel).getByRole('region', { name: 'Used lately' }),
      ).getByRole('button', { name: 'party celebration' }),
    ).toBeInTheDocument();

    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    const message = backend.sent[0]?.message ?? '';
    expect(message).toContain('charset=utf-8');
    // No picture goes with it: the emoji is in the text itself.
    expect(message).not.toContain('<img');
    expect(
      message.includes('🎉') ||
        message.includes('=F0=9F=8E=89') ||
        message.includes(Buffer.from('Well done 🎉').toString('base64')),
    ).toBe(true);
  });

  it('puts pictures among the words, sized there, and sends them as parts of the message', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    const words = within(form).getByLabelText('Message');
    await userEvent.type(within(form).getByLabelText('To'), 'bob@example.com');
    await userEvent.type(words, 'The plan: ');
    await userEvent.upload(
      within(form).getByLabelText('Insert a picture'),
      new File(['png bytes'], 'plan.png', { type: 'image/png' }),
    );
    const picture = await within(words).findByRole('img', { name: 'plan.png' });
    // It is among the words, and not listed under them as something attached.
    expect(
      within(form).queryByRole('list', { name: 'Attached' }),
    ).not.toBeInTheDocument();

    // Pressed, it says what can be done with it.
    await userEvent.click(picture);
    const bar = await within(form).findByRole('group', {
      name: 'Picture: plan.png',
    });
    await userEvent.click(within(bar).getByRole('button', { name: 'Small' }));
    await waitFor(() => expect(picture).toHaveAttribute('width', '240'));
    expect(within(bar).getByRole('button', { name: 'Small' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    const message = (backend.sent[0]?.message ?? '').replace(/=\r\n/g, '');
    // Beside the page that shows it, pointed at by an id of its own.
    expect(message).toContain('multipart/related');
    const cid = /Content-ID: <([^>]+)>/i.exec(message)?.[1];
    expect(cid).toMatch(/@mailless$/);
    expect(message).toMatch(/Content-Disposition: inline/i);
    expect(message).toMatch(
      new RegExp(
        `<img src=(3D)?"cid:${cid}" alt=(3D)?"plan.png" width=(3D)?"240"`,
      ),
    );
  });

  it('takes a picture dropped on the words into them, and attaches anything else', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    const words = within(form).getByLabelText('Message');
    await userEvent.type(within(form).getByLabelText('Subject'), 'Two things');
    const files = [
      new File(['png bytes'], 'photo.png', { type: 'image/png' }),
      new File(['words'], 'notes.txt', { type: 'text/plain' }),
    ];
    fireEvent.drop(words, {
      dataTransfer: { files, types: ['Files'], getData: () => '' },
    });

    expect(
      await within(words).findByRole('img', { name: 'photo.png' }),
    ).toBeInTheDocument();
    const attached = await within(form).findByRole('list', {
      name: 'Attached',
    });
    expect(await within(attached).findByText('notes.txt')).toBeInTheDocument();
    expect(within(attached).queryByText('photo.png')).not.toBeInTheDocument();

    // Kept as a draft and opened again, the picture is still where it was.
    await userEvent.click(within(form).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Drafts/ }),
    );
    await userEvent.click(
      await screen.findByRole('link', { name: /Two things/ }),
    );
    await userEvent.click(
      await within(reader()).findByRole('button', { name: 'Go on writing' }),
    );
    const again = await writing();
    expect(
      await within(within(again).getByLabelText('Message')).findByRole('img', {
        name: 'photo.png',
      }),
    ).toBeInTheDocument();
    const kept = within(again).getByRole('list', { name: 'Attached' });
    expect(within(kept).getByText('notes.txt')).toBeInTheDocument();
    expect(within(kept).queryByText('photo.png')).not.toBeInTheDocument();

    // Kept again as it is gone on with, then sent: the picture and the file
    // are now parts of the copy kept last, the one before it being gone.
    await userEvent.type(within(again).getByLabelText('To'), 'bob@example.com');
    expect(
      await within(again).findByText(/^Draft kept at /, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    await userEvent.type(within(again).getByLabelText('Subject'), ' more');
    expect(
      await within(again).findByText(/^Draft kept at /, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    await userEvent.click(within(again).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    const message = backend.sent[0]?.message ?? '';
    expect(message).toContain('multipart/related');
    expect(message).toContain('notes.txt');
    expect(message).toMatch(/Content-ID: <[^>]+@mailless>/i);
  }, 20_000);

  it('holds a message a moment after Send, in which it can be taken back', async () => {
    const backend = await fakeBackend({ holds: true });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    await userEvent.type(within(form).getByLabelText('To'), 'bob@example.com');
    await userEvent.type(within(form).getByLabelText('Subject'), 'Too soon');
    await userEvent.type(within(form).getByLabelText('Message'), 'Wait');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    // It has not gone: the server holds it.
    expect(backend.sent).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // Back as a draft, open to go on with.
    const again = await writing();
    expect(within(again).getByLabelText('Subject')).toHaveValue('Too soon');
    expect(within(again).getByLabelText('Message')).toHaveTextContent('Wait');
    expect(
      await within(sidebar()).findByLabelText('1 drafts'),
    ).toBeInTheDocument();
    // When its time comes, nothing is sent.
    await backend.due();
    expect(backend.sent).toHaveLength(0);

    // Sent again and left alone, it goes.
    await userEvent.click(within(again).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    await backend.due();
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.message).toContain('Subject: Too soon');
  });

  it('sends a message later, and says so until it has gone', async () => {
    const backend = await fakeBackend({ holds: true });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    await userEvent.type(within(form).getByLabelText('To'), 'bob@example.com');
    await userEvent.type(within(form).getByLabelText('Subject'), 'Monday');
    await userEvent.click(
      within(form).getByRole('button', { name: 'Send later' }),
    );
    const menu = within(form).getByRole('menu', { name: 'Send later' });
    expect(
      within(menu).getByRole('menuitem', { name: /In one hour/ }),
    ).toBeInTheDocument();

    // A time that has passed is not one to send at.
    const own = within(menu).getByLabelText('Another time');
    fireEvent.change(own, { target: { value: '2020-01-01T08:00' } });
    await userEvent.click(
      within(menu).getByRole('button', { name: 'Send then' }),
    );
    expect(within(menu).getByRole('alert')).toHaveTextContent(
      'That time has passed.',
    );

    await userEvent.click(
      within(menu).getByRole('menuitem', { name: /Tomorrow morning/ }),
    );
    expect(await screen.findByText(/^It will be sent /)).toBeInTheDocument();
    expect(backend.sent).toHaveLength(0);

    // Where it is filed, it says it has not gone yet, and can still be stopped.
    await userEvent.click(
      within(sidebar()).getByRole('link', { name: /Sent/ }),
    );
    const sent = await screen.findByRole('region', { name: 'Sent' });
    expect(await within(sent).findByText(/^To be sent /)).toBeInTheDocument();
    await userEvent.click(within(sent).getByRole('link', { name: /Monday/ }));
    expect(
      await within(reader()).findByText(/Not sent yet: it goes/),
    ).toBeInTheDocument();
    expect(
      within(reader()).getByRole('button', { name: 'Do not send it' }),
    ).toBeInTheDocument();

    // Its time comes: it goes, and no longer says otherwise.
    await backend.due();
    expect(backend.sent).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(
        within(reader()).queryByText(/Not sent yet/),
      ).not.toBeInTheDocument(),
    );
  });

  it('has the settings in the account menu too, for a phone with no room for them in the bar', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await screen.findByRole('region', { name: 'Inbox' });

    await userEvent.click(screen.getByRole('button', { name: /^Account: / }));
    const account = screen.getByRole('dialog', { name: 'Account' });
    await userEvent.click(
      within(account).getByRole('link', { name: 'Settings' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
  });

  it('checks for new mail when the page is pulled down, without loading it again', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    await within(inbox).findByText('Plans');
    await backend.deliver({ subject: 'Just in' });
    const finger = (clientY: number) => ({
      touches: [{ clientX: 100, clientY }],
    });

    // Not far enough: nothing is asked.
    fireEvent.touchStart(inbox, finger(100));
    fireEvent.touchMove(inbox, finger(160));
    fireEvent.touchEnd(inbox);
    expect(screen.queryByText('Checking for new mail…')).toBeNull();

    // Where the list has been scrolled, a finger drawn down only scrolls it back.
    inbox.scrollTop = 40;
    fireEvent.touchStart(inbox, finger(100));
    fireEvent.touchMove(inbox, finger(400));
    fireEvent.touchEnd(inbox);
    expect(screen.queryByText('Checking for new mail…')).toBeNull();
    expect(within(inbox).queryByText('Just in')).not.toBeInTheDocument();

    inbox.scrollTop = 0;
    fireEvent.touchStart(inbox, finger(100));
    fireEvent.touchMove(inbox, finger(400));
    fireEvent.touchEnd(inbox);
    expect(screen.getByText('Checking for new mail…')).toBeInTheDocument();
    expect(await within(inbox).findByText('Just in')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Checking for new mail…')).toBeNull(),
    );
  });

  it('sends at once where the server cannot hold a message', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    expect(
      within(form).queryByRole('button', { name: 'Send later' }),
    ).not.toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('To'), 'bob@example.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Undo' }),
    ).not.toBeInTheDocument();
    expect(backend.sent).toHaveLength(1);
  });

  it('has several messages open at once, one in front and the others down to their titles', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    const windows = () =>
      screen.findAllByRole('dialog', { name: 'Write a message' });
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const first = (await windows())[0] as HTMLElement;
    await userEvent.type(within(first).getByLabelText('Subject'), 'One');
    await userEvent.type(
      within(first).getByLabelText('Message'),
      'First words',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Write' }));
    await waitFor(async () => expect(await windows()).toHaveLength(2));
    const second = (await windows())[1] as HTMLElement;
    // The new one is in front; the one before it waits, with nothing lost.
    expect(second).toHaveClass('compose-docked');
    expect(first).toHaveClass('compose-minimised');
    expect(within(first).getByRole('heading', { name: 'One' })).toBeVisible();
    await userEvent.type(within(second).getByLabelText('Subject'), 'Two');

    await userEvent.click(
      within(first).getByRole('button', { name: 'Open the window again' }),
    );
    expect(first).toHaveClass('compose-docked');
    expect(second).toHaveClass('compose-minimised');
    expect(within(first).getByLabelText('Message')).toHaveTextContent(
      'First words',
    );
    expect(within(first).getByLabelText('Subject')).toHaveValue('One');
    expect(within(second).getByLabelText('Subject')).toHaveValue('Two');

    // Three is as many as fit.
    await userEvent.click(screen.getByRole('button', { name: 'Write' }));
    await waitFor(async () => expect(await windows()).toHaveLength(3));
    await userEvent.click(screen.getByRole('button', { name: 'Write' }));
    expect(
      await screen.findByText(
        'Close one of the messages you are writing to start another.',
      ),
    ).toBeInTheDocument();
    expect(await windows()).toHaveLength(3);

    // Closing the one in front brings the one before it forward.
    const third = (await windows())[2] as HTMLElement;
    await userEvent.click(within(third).getByRole('button', { name: 'Close' }));
    await waitFor(async () => expect(await windows()).toHaveLength(2));
    expect(second).toHaveClass('compose-docked');
  });

  it('asks before sending words about something attached with nothing attached', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    await userEvent.type(within(form).getByLabelText('To'), 'bob@example.com');
    await userEvent.type(
      within(form).getByLabelText('Message'),
      'The notes are attached.',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    const asked = within(form).getByRole('alertdialog', {
      name: 'Nothing is attached',
    });
    expect(backend.sent).toHaveLength(0);
    await userEvent.click(
      within(asked).getByRole('button', { name: 'Send as it is' }),
    );
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(backend.sent).toHaveLength(1);
  });

  it('attaches files, which go with the message', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('button', { name: 'Write' }));
    const form = await writing();
    await userEvent.type(within(form).getByLabelText('To'), 'bob@example.com');
    await userEvent.upload(
      within(form).getByLabelText('Attach files'),
      new File(['Clause 7'], 'notes.txt', { type: 'text/plain' }),
    );
    const attached = await within(form).findByRole('list', {
      name: 'Attached',
    });
    expect(await within(attached).findByText('8 B')).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(backend.sent[0]?.message).toContain('notes.txt');
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

  it('narrows a search by what is typed, and by who is picked while typing', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Contract from Bob',
      from: 'Bob Stone <bob@example.com>',
      text: 'The contract',
    });
    await backend.deliver({
      subject: 'Contract from Carol',
      from: 'Carol <carol@example.com>',
      text: 'The contract',
    });
    await renderApp(backend);
    await screen.findByRole('region', { name: 'Inbox' });
    const bar = screen.getByRole('search');
    const field = within(bar).getByRole('searchbox', { name: 'Search mail' });

    // What can be typed is said under the bar, and who is being named is offered.
    await userEvent.type(field, 'contract from:bo');
    expect(within(bar).getByText('who wrote it')).toBeInTheDocument();
    await userEvent.click(
      await within(bar).findByRole('option', { name: /Bob Stone/ }),
    );
    const narrowed = within(bar).getByRole('list', {
      name: 'What narrows the search',
    });
    expect(within(narrowed).getByText('Bob Stone')).toBeInTheDocument();
    expect(field).toHaveValue('contract');

    await userEvent.type(field, '{Enter}');
    const found = await screen.findByRole('region', { name: /^Search:/ });
    expect(
      await within(found).findByText('Contract from Bob'),
    ).toBeInTheDocument();
    expect(
      within(found).queryByText('Contract from Carol'),
    ).not.toBeInTheDocument();

    // Taken out of the bar, it narrows the search no more.
    await userEvent.click(
      within(bar).getByRole('button', { name: 'Remove from:bob@example.com' }),
    );
    const wider = await screen.findByRole('region', {
      name: 'Search: contract',
    });
    expect(
      await within(wider).findByText('Contract from Carol'),
    ).toBeInTheDocument();

    // A word typed in full narrows it as soon as it is finished.
    await userEvent.type(field, ' from:carol ');
    expect(within(narrowed).getByText('carol')).toBeInTheDocument();
    expect(field).toHaveValue('contract ');

    // One press empties the search, and leaves what it found.
    await userEvent.click(
      within(bar).getByRole('button', { name: 'Clear the search' }),
    );
    expect(await screen.findByRole('region', { name: 'Inbox' })).toBeVisible();
    expect(field).toHaveValue('');
    expect(within(narrowed).queryByText('carol')).not.toBeInTheDocument();
  });

  it('narrows a search by filling in a form, which says the same as the bar', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Invoice 42',
      from: 'Bob <bob@example.com>',
      attachment: {
        name: 'invoice.pdf',
        type: 'application/pdf',
        base64: 'JVBERg==',
      },
    });
    await backend.deliver({
      subject: 'Invoice talk',
      from: 'Bob <bob@example.com>',
    });
    await renderApp(backend);
    await screen.findByRole('region', { name: 'Inbox' });
    const bar = screen.getByRole('search');
    const field = within(bar).getByRole('searchbox', { name: 'Search mail' });
    // At the end of the bar, and again under what can be typed: either opens the form.
    const options = () =>
      within(bar).getAllByRole('button', {
        name: 'Show search options',
      })[0] as HTMLElement;

    // What was typed is in the form already.
    await userEvent.type(field, 'subject:invoice ');
    await userEvent.click(options());
    const form = within(bar).getByRole('group', { name: 'Search options' });
    expect(within(form).getByLabelText('Subject')).toHaveValue('invoice');

    await userEvent.click(within(form).getByLabelText('Has an attachment'));
    await userEvent.type(within(form).getByLabelText('From'), 'bob');
    await userEvent.selectOptions(
      within(form).getByLabelText('Received'),
      'In the last year',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Search' }));

    const found = await screen.findByRole('region', { name: /^Search:/ });
    expect(await within(found).findByText('Invoice 42')).toBeInTheDocument();
    expect(within(found).queryByText('Invoice talk')).not.toBeInTheDocument();
    // And what was filled in is in the bar, as it would have been typed.
    const narrowed = within(bar).getByRole('list', {
      name: 'What narrows the search',
    });
    expect(
      within(narrowed)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'from:bob',
      'subject:invoice',
      'has:attachment',
      'newer:in the last year',
      '',
    ]);

    // Everything can be emptied at once.
    await userEvent.click(options());
    await userEvent.click(
      within(bar).getByRole('button', { name: 'Clear all' }),
    );
    expect(
      within(
        within(bar).getByRole('group', { name: 'Search options' }),
      ).getByLabelText('From'),
    ).toHaveValue('');
    expect(within(narrowed).getAllByRole('listitem')).toHaveLength(1);
  });

  it('makes folders in the settings, one inside another, and shows them in the menu', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    const settings = await screen.findByRole('region', { name: 'Settings' });
    expect(
      within(settings).getByText('You have made no folders yet.'),
    ).toBeInTheDocument();
    // Nothing in the menu makes one: that is done here.
    expect(screen.queryByRole('button', { name: 'New mailbox' })).toBeNull();

    await userEvent.click(
      within(settings).getByRole('button', { name: 'New folder' }),
    );
    await userEvent.type(
      within(settings).getByLabelText('Name of the new folder'),
      'Clients{Enter}',
    );
    expect(await screen.findByText('Clients was made')).toBeInTheDocument();
    await userEvent.click(
      within(settings).getByRole('button', {
        name: 'New folder inside Clients',
      }),
    );
    await userEvent.type(
      within(settings).getByLabelText('Name of the new folder inside Clients'),
      'Acme{Enter}',
    );
    expect(await screen.findByText('Acme was made')).toBeInTheDocument();
    expect(
      within(
        within(settings).getByRole('list', { name: 'Your folders' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(2);

    // In the menu, under their own heading; what is inside a folder folds away.
    expect(
      within(sidebar()).getByRole('button', { name: 'Folders' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(sidebar()).getByRole('link', { name: 'Acme' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(sidebar()).getByRole('button', {
        name: 'Hide what is inside Clients',
      }),
    );
    expect(within(sidebar()).queryByRole('link', { name: 'Acme' })).toBeNull();
    expect(
      within(sidebar()).getByRole('link', { name: 'Clients' }),
    ).toBeInTheDocument();
  });

  it('renames a folder, moves it and deletes it, in the settings', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    const settings = await screen.findByRole('region', { name: 'Settings' });
    for (const name of ['Clients', 'Invoices']) {
      await userEvent.click(
        within(settings).getByRole('button', { name: 'New folder' }),
      );
      await userEvent.type(
        within(settings).getByLabelText('Name of the new folder'),
        `${name}{Enter}`,
      );
      await screen.findByText(`${name} was made`);
    }

    // Another name, and inside the other one.
    await userEvent.click(
      within(settings).getByRole('button', {
        name: 'Rename or move Invoices',
      }),
    );
    const name = within(settings).getByLabelText('Name of Invoices');
    await userEvent.clear(name);
    await userEvent.type(name, 'Bills');
    await userEvent.selectOptions(
      within(settings).getByLabelText('Inside'),
      'Clients',
    );
    await userEvent.click(
      within(name.closest('form') as HTMLElement).getByRole('button', {
        name: 'Save',
      }),
    );
    expect(await screen.findByText('Bills was changed')).toBeInTheDocument();
    expect(
      within(sidebar()).getByRole('button', {
        name: 'Hide what is inside Clients',
      }),
    ).toBeInTheDocument();

    // Gone only after being asked.
    await userEvent.click(
      within(settings).getByRole('button', { name: 'Delete Bills' }),
    );
    await userEvent.click(
      within(
        within(settings).getByRole('alertdialog', { name: 'Delete Bills' }),
      ).getByRole('button', { name: 'Delete it' }),
    );
    expect(await screen.findByText('Bills was deleted')).toBeInTheDocument();
    expect(within(sidebar()).queryByRole('link', { name: 'Bills' })).toBeNull();
  });

  it('tags a conversation, shows the tag on it, and finds it by the tag from the menu', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Old news' });
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Plans/ }));
    await within(reader()).findByRole('article');

    // Made on the spot, by typing its name, and put on what is being read.
    await userEvent.click(
      within(reader()).getByRole('button', { name: 'Tags' }),
    );
    const picker = screen.getByRole('dialog', {
      name: 'Tags of this conversation',
    });
    expect(
      within(picker).getByRole('checkbox', { name: 'Important' }),
    ).not.toBeChecked();
    await userEvent.type(
      within(picker).getByLabelText('Find or make a tag'),
      'Work',
    );
    await userEvent.click(
      within(picker).getByRole('button', { name: 'Make the tag “Work”' }),
    );
    expect(
      await within(picker).findByRole('checkbox', { name: 'Work' }),
    ).toBeChecked();
    await userEvent.click(
      within(picker).getByRole('checkbox', { name: 'Important' }),
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /Tags of/ })).toBeNull();

    // On the conversation and on its line in the list.
    const subject = within(reader()).getByRole('heading', { level: 2 });
    expect(subject).toHaveTextContent('Work');
    expect(subject).toHaveTextContent('Important');
    const row = within(list('Inbox'))
      .getByRole('link', { name: /Plans/ })
      .closest('li') as HTMLElement;
    expect(row).toHaveTextContent('Work');

    // In the menu, and behind it everything that has it and nothing else.
    await userEvent.click(
      await within(sidebar()).findByRole('link', { name: 'Work' }),
    );
    const found = await screen.findByRole('region', { name: /^Search/ });
    expect(await within(found).findByText('Plans')).toBeInTheDocument();
    expect(within(found).queryByText('Old news')).not.toBeInTheDocument();
    expect(
      screen.getByRole('searchbox', { name: 'Search mail' }),
    ).toBeDefined();

    // Taken off where it is shown.
    await userEvent.click(within(found).getByRole('link', { name: /Plans/ }));
    await userEvent.click(
      await within(reader()).findByRole('button', {
        name: 'Remove the tag Work',
      }),
    );
    await waitFor(() =>
      expect(
        within(reader()).getByRole('heading', { level: 2 }),
      ).not.toHaveTextContent('Work'),
    );
  });

  it('stars a conversation from its line, and lists what is starred', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Old news' });
    await backend.deliver({ subject: 'Plans' });
    await renderApp(backend);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    await userEvent.click(
      await within(inbox).findByRole('button', { name: 'Star: Plans' }),
    );
    expect(
      await within(inbox).findByRole('button', {
        name: 'Remove the star: Plans',
      }),
    ).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(
      within(sidebar()).getByRole('link', { name: 'Starred' }),
    );
    const found = await screen.findByRole('region', { name: /^Search/ });
    expect(await within(found).findByText('Plans')).toBeInTheDocument();
    expect(within(found).queryByText('Old news')).not.toBeInTheDocument();
  });

  it('keeps the tags in the settings: made, renamed, recoloured and deleted', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    const settings = await screen.findByRole('region', { name: 'Settings' });
    const tags = await within(settings).findByRole('list', {
      name: 'Your tags',
    });
    // The two that are always there cannot be changed.
    expect(within(tags).getAllByText('Always there')).toHaveLength(2);
    expect(
      within(tags).queryByRole('button', { name: /Delete the tag Important/ }),
    ).toBeNull();

    await userEvent.click(
      within(settings).getByRole('button', { name: 'New tag' }),
    );
    await userEvent.type(
      within(settings).getByLabelText('Name of the new tag'),
      'Work',
    );
    await userEvent.click(
      within(settings).getByRole('radio', { name: 'Green' }),
    );
    await userEvent.keyboard('{Enter}');
    await userEvent.click(
      within(settings).getByLabelText('Name of the new tag'),
    );
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Work was made')).toBeInTheDocument();
    expect(
      await within(sidebar()).findByRole('link', { name: 'Work' }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(tags).getByRole('button', { name: 'Rename or recolour Work' }),
    );
    const name = within(tags).getByLabelText('Name of Work');
    expect(within(tags).getByRole('radio', { name: 'Green' })).toBeChecked();
    await userEvent.clear(name);
    await userEvent.type(name, 'Office{Enter}');
    expect(await screen.findByText('Office was changed')).toBeInTheDocument();

    await userEvent.click(
      within(tags).getByRole('button', { name: 'Delete the tag Office' }),
    );
    await userEvent.click(
      within(
        within(tags).getByRole('alertdialog', {
          name: 'Delete the tag Office',
        }),
      ).getByRole('button', { name: 'Delete the tag' }),
    );
    expect(await screen.findByText('Office was deleted')).toBeInTheDocument();
    expect(
      within(sidebar()).queryByRole('link', { name: 'Office' }),
    ).toBeNull();
  });

  it('folds a part of the menu away, says what waits in it, and remembers', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Spam', mailbox: 'junk' });
    await renderApp(backend);
    await screen.findByRole('region', { name: 'Inbox' });
    const more = within(sidebar()).getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(sidebar()).getByRole('link', { name: /Trash/ }),
    ).toBeInTheDocument();

    await userEvent.click(more);
    expect(within(sidebar()).queryByRole('link', { name: /Trash/ })).toBeNull();
    expect(
      within(sidebar()).getByRole('button', { name: /More/ }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(within(sidebar()).getByLabelText('1 unread')).toBeInTheDocument();
    expect(window.localStorage.getItem('mailless.mail.more-open')).toBe(
      'false',
    );
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
      within(await screen.findByRole('banner')).getByRole('link', {
        name: 'Settings',
      }),
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
    const message = await writing();
    // The signature is shown under the words, and is not among them.
    expect(within(message).getByLabelText('Signature')).toHaveTextContent(
      'Ann Lee Example Ltd',
    );
    await userEvent.type(
      within(message).getByLabelText('To'),
      'bob@example.com',
    );
    await userEvent.click(
      within(message).getByRole('button', { name: 'Send' }),
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

    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
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

    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
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
