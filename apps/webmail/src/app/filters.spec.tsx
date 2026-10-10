import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBackend, renderApp } from '../test-support';

const AUTH = { accountId: 'ann', username: 'ann@example.com' };
type Backend = Awaited<ReturnType<typeof fakeBackend>>;

/** What the server keeps, asked of it directly. */
async function call(backend: Backend, method: string, args: object = {}) {
  const response = (await backend.server.handleRequest(
    {
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:mail',
        'urn:ietf:params:jmap:sieve',
      ],
      methodCalls: [[method, { accountId: AUTH.accountId, ...args }, 'c']],
    },
    AUTH,
  )) as unknown as { methodResponses: [string, Record<string, never>][] };
  return response.methodResponses[0]?.[1] as Record<string, never>;
}

/** The script in use, as the server has it. */
async function script(backend: Backend): Promise<string> {
  const { list } = (await call(backend, 'SieveScript/get', {
    ids: null,
  })) as unknown as {
    list: Array<{ blobId: string; isActive: boolean }>;
  };
  const used = list.find((each) => each.isActive);
  if (!used) return '';
  const data = await backend.server.download(AUTH, AUTH.accountId, used.blobId);
  return new TextDecoder().decode(data ?? new Uint8Array());
}

const settings = () => screen.findByRole('region', { name: 'Settings' });

describe('filters', () => {
  it('makes a filter on a form, tries it, and has the server file what arrives', async () => {
    const backend = await fakeBackend();
    const invoices = (
      (await call(backend, 'Mailbox/set', {
        create: { m: { name: 'Invoices', parentId: null } },
      })) as unknown as { created: { m: { id: string } } }
    ).created.m.id;
    await backend.deliver({
      subject: 'Invoice 103',
      from: 'Nordlys <billing@nordlys.example>',
    });
    await backend.deliver({ subject: 'Lunch?', from: 'Bob <bob@example.com>' });
    await renderApp(backend, '/settings');
    const page = await settings();
    await userEvent.click(
      await within(page).findByRole('button', { name: 'New filter' }),
    );
    const form = await within(page).findByRole('form', { name: 'Filter' });
    // Nothing to save until it says what it is, and what it does.
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.type(within(form).getByLabelText('Name'), 'Invoices');
    await userEvent.type(
      within(form).getByLabelText('Condition 1: value'),
      'nordlys.example',
    );
    await userEvent.click(
      within(form).getByRole('button', { name: /Another action/ }),
    );
    expect(within(form).getByLabelText('Action 1')).toHaveValue('move');
    await userEvent.selectOptions(
      within(form).getByLabelText('Action 1: folder'),
      'Invoices',
    );
    await userEvent.click(
      within(form).getByRole('button', { name: /Another action/ }),
    );
    await userEvent.selectOptions(
      within(form).getByLabelText('Action 2'),
      'read',
    );

    // Tried first: it says what it would have caught, and touches nothing.
    await userEvent.click(
      within(form).getByRole('button', { name: /Try it on your last/ }),
    );
    const trial = within(form).getByRole('complementary', {
      name: 'What it would have done',
    });
    expect(await within(trial).findByText('Invoice 103')).toBeInTheDocument();
    expect(within(trial).queryByText('Lunch?')).not.toBeInTheDocument();
    await userEvent.click(
      within(trial).getByLabelText(/Also do it to these 1 now/),
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    const list = await within(page).findByRole('list', { name: 'Filters' });
    expect(
      within(list).getByText(
        /If from contains “nordlys.example” → mark read, move to Invoices/,
      ),
    ).toBeInTheDocument();
    expect(await script(backend)).toContain(
      `# rule:[Invoices]\nif address :contains "from" "nordlys.example" {\n    addflag "\\\\Seen";\n    fileinto :mailboxid "${invoices}" "Invoices";\n}`,
    );
    // What was already here was done to as well.
    await waitFor(async () => {
      const { ids } = (await call(backend, 'Email/query', {
        filter: { inMailbox: invoices },
      })) as unknown as { ids: string[] };
      expect(ids).toHaveLength(1);
    });

    // What arrives from now on is filed by the server.
    const next = await backend.deliver({
      subject: 'Invoice 104',
      from: 'Nordlys <billing@nordlys.example>',
    });
    const [filed] = (
      (await call(backend, 'Email/get', {
        ids: [next],
        properties: ['mailboxIds', 'keywords'],
      })) as unknown as {
        list: Array<{
          mailboxIds: Record<string, boolean>;
          keywords: Record<string, boolean>;
        }>;
      }
    ).list;
    expect(filed?.mailboxIds).toEqual({ [invoices]: true });
    expect(filed?.keywords).toMatchObject({ $seen: true });

    // Off, it is kept and does nothing.
    await userEvent.click(within(list).getByLabelText('Invoices is on'));
    await waitFor(async () =>
      expect(await script(backend)).toContain('# rule:[Invoices] off\n#| if'),
    );
  });

  it('is one script, which is checked before it is kept, and shows what the form cannot', async () => {
    const backend = await fakeBackend();
    await backend.deliver({
      subject: 'Your receipt',
      from: 'shop@example.net',
    });
    await renderApp(backend, '/settings');
    const page = await settings();
    await userEvent.click(
      await within(page).findByRole('button', { name: 'Edit as a script' }),
    );
    const section = await within(page).findByRole('region', {
      name: 'Filters, as a script',
    });
    const editor = within(section).getByLabelText('The script');
    const write = (text: string) =>
      fireEvent.change(editor, { target: { value: text } });
    write(
      'require "imap4flags";\n# rule:[Shops]\nif header :matches "subject" "*receipt*" { addflag "$flagged" }',
    );
    await userEvent.click(
      within(section).getByRole('button', { name: 'Save' }),
    );
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      /Line 3: “;” is expected here/,
    );
    expect(await script(backend)).toBe('');

    write(
      'require "imap4flags";\n# rule:[Shops]\nif header :matches "subject" "*receipt*" { addflag "$flagged"; }',
    );
    await userEvent.click(
      within(section).getByRole('button', { name: 'Try it' }),
    );
    const tried = await within(section).findByRole('complementary', {
      name: 'Tried, and nothing touched',
    });
    expect(within(tried).getByText('Your receipt')).toBeInTheDocument();
    expect(
      within(tried).getByText(/left where it is, starred/),
    ).toBeInTheDocument();

    await userEvent.click(
      within(section).getByRole('button', { name: 'Save' }),
    );
    const list = await within(page).findByRole('list', { name: 'Filters' });
    // Wildcards are more than the form says: it is the script's to change.
    expect(within(list).getByText('written by hand')).toBeInTheDocument();
    expect(
      within(list).getByRole('button', { name: 'Change Shops in the script' }),
    ).toBeInTheDocument();
    expect(await script(backend)).toContain('# rule:[Shops]');
  });
});
