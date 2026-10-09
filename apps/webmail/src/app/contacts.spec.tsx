import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBackend, renderApp } from '../test-support';

const people = (name: string | RegExp = 'All contacts') =>
  screen.findByRole('region', { name });
const person = () => screen.getByRole('region', { name: 'Contact' });

async function add(fields: Record<string, string>) {
  await userEvent.click(screen.getByRole('link', { name: 'New contact' }));
  const form = await screen.findByRole('form', { name: 'New contact' });
  for (const [label, value] of Object.entries(fields)) {
    await userEvent.type(within(form).getByLabelText(label), value);
  }
  await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByRole('form')).not.toBeInTheDocument(),
  );
}

describe('the contacts', () => {
  it('are reached from beside the mail, and start with nobody', async () => {
    const backend = await fakeBackend();
    await renderApp(backend);
    await userEvent.click(
      await screen.findByRole('link', { name: 'Contacts' }),
    );
    await people();
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      await within(person()).findByText('Nobody is in your contacts yet.'),
    ).toBeInTheDocument();
    expect(document.title).toBe('Contacts · mailless');
  });

  it('keep someone: added, shown, changed, found and removed', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/contacts');
    await people();
    await add({
      Name: 'Marta Lindqvist',
      Company: 'Northwind Legal',
      Title: 'Partner',
      'Email 1': 'marta@northwind.example',
      'Phone 1': '+46 70 555 01 87',
      Notes: 'Prefers a call.',
    });
    expect(
      await screen.findByText('Marta Lindqvist was added to your contacts'),
    ).toBeInTheDocument();

    // In the list under their letter, and open beside it.
    const list = await people();
    expect(
      within(within(list).getByRole('region', { name: 'M' })).getByRole(
        'link',
        {
          name: /Marta Lindqvist/,
        },
      ),
    ).toHaveClass('active');
    expect(
      within(person()).getByRole('heading', { name: 'Marta Lindqvist' }),
    ).toBeInTheDocument();
    expect(
      within(person()).getAllByText('Partner · Northwind Legal').length,
    ).toBeGreaterThan(0);
    expect(within(person()).getByText('marta@northwind.example')).toBeVisible();
    expect(
      within(person()).getByRole('link', { name: 'Call +46 70 555 01 87' }),
    ).toHaveAttribute('href', 'tel:+46705550187');
    expect(within(person()).getByText('Prefers a call.')).toBeInTheDocument();

    // Changed: another address, and no title any more.
    await userEvent.click(within(person()).getByRole('link', { name: 'Edit' }));
    const form = await screen.findByRole('form', {
      name: 'Edit Marta Lindqvist',
    });
    expect(within(form).getByLabelText('Email 1')).toHaveValue(
      'marta@northwind.example',
    );
    await userEvent.clear(within(form).getByLabelText('Title'));
    await userEvent.click(
      within(form).getByRole('button', { name: 'Add an email' }),
    );
    await userEvent.type(within(form).getByLabelText('Email 2'), 'not one');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      '“not one” is not an address.',
    );
    await userEvent.clear(within(form).getByLabelText('Email 2'));
    await userEvent.type(
      within(form).getByLabelText('Email 2'),
      'marta@post.example',
    );
    await userEvent.selectOptions(
      within(form).getByLabelText('Kind of email 2'),
      'Home',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(
      await within(person()).findByText('marta@post.example'),
    ).toBeInTheDocument();
    expect(within(person()).queryByText(/Partner/)).not.toBeInTheDocument();

    // Found by anything the card says.
    await add({ Name: 'Erik Sund', 'Email 1': 'erik@sund.example' });
    const search = within(await people()).getByLabelText('Search contacts');
    await userEvent.type(search, 'northwind');
    expect(
      within(await people()).queryByRole('link', { name: /Erik Sund/ }),
    ).not.toBeInTheDocument();
    expect(
      within(await people()).getByRole('link', { name: /Marta Lindqvist/ }),
    ).toBeInTheDocument();
    // One press empties the search again.
    await userEvent.click(
      within(await people()).getByRole('button', { name: 'Clear the search' }),
    );
    expect(search).toHaveValue('');
    expect(
      within(await people()).getByRole('link', { name: /Erik Sund/ }),
    ).toBeInTheDocument();

    // Looking at some of them says so, with the way back to everyone beside it.
    await userEvent.click(
      screen.getByRole('link', { name: 'Written to often' }),
    );
    const often = await people('Written to often');
    expect(within(often).getByText('Nobody here yet.')).toBeInTheDocument();
    // Beside what they are, and again under "nobody here": either leads back.
    const back = within(often).getAllByRole('link', {
      name: 'Show all contacts',
    });
    expect(back).toHaveLength(2);
    await userEvent.click(back[0] as HTMLElement);
    expect(
      within(await people()).getByRole('link', { name: /Erik Sund/ }),
    ).toBeInTheDocument();

    // Removed, after asking.
    await userEvent.click(
      within(await people()).getByRole('link', { name: /Marta Lindqvist/ }),
    );
    await userEvent.click(
      await within(person()).findByRole('button', {
        name: 'More for this contact',
      }),
    );
    await userEvent.click(
      within(person()).getByRole('menuitem', { name: 'Delete this contact' }),
    );
    await userEvent.click(
      within(
        within(person()).getByRole('alertdialog', {
          name: 'Delete the contact',
        }),
      ).getByRole('button', { name: 'Delete' }),
    );
    expect(
      await screen.findByText('Marta Lindqvist was removed from your contacts'),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect(
        within(await people()).queryByRole('link', { name: /Marta/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it('are who a message is offered to, and are written to from their card', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/contacts');
    await people();
    await add({ Name: 'Bea Baker', 'Email 1': 'bea@example.net' });

    await userEvent.click(
      await within(person()).findByRole('button', { name: 'Write' }),
    );
    const form = await screen.findByRole('dialog', { name: 'Write a message' });
    expect(
      within(within(form).getByRole('list', { name: 'To: people' })).getByText(
        'Bea Baker',
      ),
    ).toBeInTheDocument();

    // And offered while typing, to anyone else it is for.
    await userEvent.click(
      within(form).getByRole('button', { name: 'Cc, Bcc' }),
    );
    await userEvent.type(within(form).getByLabelText('Cc'), 'bak');
    // Not her again: the message is for her already.
    expect(
      within(form).queryByRole('listbox', { name: 'Cc: suggestions' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(form).getByRole('button', { name: 'Remove Bea Baker' }),
    );
    await userEvent.type(within(form).getByLabelText('Cc'), 'e');
    expect(
      within(
        await within(form).findByRole('listbox', { name: 'Cc: suggestions' }),
      ).getByRole('option', { name: /Bea Baker/ }),
    ).toBeInTheDocument();
  });

  it('take in whoever wrote a message, with what the message says of them', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Hello',
      from: 'Bob Stone <bob@example.com>',
    });
    await renderApp(backend);
    await userEvent.click(await screen.findByRole('link', { name: /Hello/ }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'More for this message' }),
    );
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Add Bob Stone to contacts' }),
    );
    const form = await screen.findByRole('form', { name: 'New contact' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Bob Stone');
    expect(within(form).getByLabelText('Email 1')).toHaveValue(
      'bob@example.com',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(person()).findByRole('heading', { name: 'Bob Stone' }),
    ).toBeInTheDocument();
    // The mail there has been with them is beside how to reach them.
    const mail = await within(person()).findByRole('region', {
      name: 'Recent mail',
    });
    expect(within(mail).getByText('Hello')).toBeInTheDocument();
    expect(
      within(mail)
        .getByRole('link', { name: 'All mail with Bob Stone' })
        .getAttribute('href'),
    ).toMatch(/\/search\?q=bob%40example\.com$/);
  });

  it('put a face to mail: the picture kept of someone is beside what they write', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Hello',
      from: 'Bob Stone <bob@example.com>',
    });
    await renderApp(backend, '/contacts');
    await people();
    await userEvent.click(screen.getByRole('link', { name: 'New contact' }));
    const form = await screen.findByRole('form', { name: 'New contact' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Bob Stone');
    await userEvent.type(
      within(form).getByLabelText('Email 1'),
      'bob@example.com',
    );
    await userEvent.upload(
      within(form).getByLabelText('Choose a photo'),
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        'bob.png',
        {
          type: 'image/png',
        },
      ),
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByRole('form')).not.toBeInTheDocument(),
    );
    // On their card, and in the list of people.
    await waitFor(() =>
      expect(person().querySelector('img.contact-photo')).not.toBeNull(),
    );
    const list = await people();
    await waitFor(() =>
      expect(list.querySelector('img.avatar-photo')).not.toBeNull(),
    );

    // And beside their mail: in the list of it, and on the message.
    await userEvent.click(screen.getByRole('link', { name: 'Mail' }));
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    await waitFor(() =>
      expect(inbox.querySelector('img.avatar-photo')).not.toBeNull(),
    );
    await userEvent.click(within(inbox).getByRole('link', { name: /Hello/ }));
    const message = await screen.findByRole('article', {
      name: 'Message from Bob Stone',
    });
    await waitFor(() =>
      expect(message.querySelector('img.avatar-photo')).not.toBeNull(),
    );
  });

  it('keep a picture of oneself, chosen in the settings', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/settings');
    const input = await screen.findByLabelText('Choose your picture');
    const account = () => screen.getByRole('button', { name: 'Account: Ann' });
    expect(account().querySelector('img')).toBeNull();

    await userEvent.upload(
      input,
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        'me.png',
        {
          type: 'image/png',
        },
      ),
    );
    expect(
      await screen.findByText('Your picture was changed'),
    ).toBeInTheDocument();
    // Where the account is shown, it is the picture now.
    await waitFor(() =>
      expect(account().querySelector('img.avatar-photo')).not.toBeNull(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    expect(
      await screen.findByText('Your picture was removed'),
    ).toBeInTheDocument();
    await waitFor(() => expect(account().querySelector('img')).toBeNull());

    // Not something to choose a picture with: said, and nothing is kept.
    await userEvent.upload(
      screen.getByLabelText('Choose your picture'),
      new File(['words'], 'notes.txt', { type: 'text/plain' }),
      { applyAccept: false },
    );
    expect(
      await screen.findByText('A picture is a PNG, JPEG, GIF or WebP file.'),
    ).toBeInTheDocument();
  });

  it('folds its menu down to icons with the button in the top bar, as the mailboxes do', async () => {
    const backend = await fakeBackend();
    await renderApp(backend, '/contacts');
    const side = (
      await screen.findByRole('navigation', { name: 'Address books' })
    ).parentElement as HTMLElement;
    expect(side).not.toHaveClass('side-folded');
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(side).toHaveClass('side-folded');
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(side).not.toHaveClass('side-folded');
  });
});
