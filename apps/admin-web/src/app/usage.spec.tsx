import { render, screen, within } from '@testing-library/react';
import { formatSize, Usage, usageText } from './components';
import { fakeBackend, renderApp } from '../test-support';

const MB = 1024 * 1024;

describe('how full a mailbox is', () => {
  it('writes sizes the way people read them', () => {
    expect(formatSize(0)).toBe('0 bytes');
    expect(formatSize(900)).toBe('900 bytes');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(250 * MB)).toBe('250 MB');
    expect(formatSize(1.25 * 1024 * MB)).toBe('1.3 GB');
    expect(formatSize(5 * 1024 * MB)).toBe('5 GB');
  });

  it('says what is used, of how much, or that it is not known', () => {
    expect(usageText({ usedOctets: 250 * MB, limitOctets: 1024 * MB })).toBe(
      '250 MB of 1 GB (24%)',
    );
    expect(usageText({ usedOctets: 250 * MB, limitOctets: null })).toBe(
      '250 MB · no limit',
    );
    expect(usageText({ usedOctets: null, limitOctets: 1024 * MB })).toBe(
      'Not counted yet · 1 GB allowed',
    );
    expect(usageText({ usedOctets: null, limitOctets: null })).toBe(
      'Not counted yet',
    );
  });

  it('draws a bar only when there is a limit to measure against', () => {
    const { rerender } = render(
      <Usage usage={{ usedOctets: 900 * MB, limitOctets: 1024 * MB }} />,
    );
    const meter = screen.getByRole('meter', { name: 'Mailbox space used' });
    expect(meter).toHaveAttribute('max', String(1024 * MB));
    expect(meter).toHaveAttribute('value', String(900 * MB));

    // More than allowed still fills the bar, and the words say by how much.
    rerender(
      <Usage usage={{ usedOctets: 2048 * MB, limitOctets: 1024 * MB }} />,
    );
    expect(screen.getByRole('meter')).toHaveAttribute(
      'value',
      String(1024 * MB),
    );
    expect(screen.getByText('2 GB of 1 GB (200%)')).toBeInTheDocument();

    rerender(<Usage usage={{ usedOctets: 5 * MB, limitOctets: null }} />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    rerender(<Usage usage={{ usedOctets: null, limitOctets: 1024 * MB }} />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(
      screen.getByText(/counted the first time it is used/),
    ).toBeInTheDocument();
  });

  it('shows on a user’s own page, in the list of accounts and on each account', async () => {
    const backend = fakeBackend({ username: 'root', isAdmin: true });
    const usage = { usedOctets: 250 * MB, limitOctets: 1024 * MB };
    for (const account of backend.state.accounts.values()) {
      if (account.id === 'root') account.usage = usage;
    }

    const own = await renderApp(backend, '/');
    expect(await screen.findByText('250 MB of 1 GB (24%)')).toBeInTheDocument();
    own.unmount();

    const list = await renderApp(backend, '/accounts');
    const table = await screen.findByRole('table');
    expect(
      within(table).getByRole('columnheader', { name: 'Mailbox' }),
    ).toBeInTheDocument();
    expect(within(table).getByText('250 MB of 1 GB (24%)')).toBeInTheDocument();
    // An account that has not been counted says so, rather than "empty".
    expect(within(table).getByText('Not counted yet')).toBeInTheDocument();
    list.unmount();

    await renderApp(backend, '/accounts/root');
    expect(await screen.findByText('250 MB of 1 GB (24%)')).toBeInTheDocument();
  });
});
