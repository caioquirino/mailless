import { InMemoryDirectory } from '@mailless/directory';
import { UsageError } from './app-password-cli.js';
import { runDirectoryCommand } from './directory-cli.js';

function setup(directory = new InMemoryDirectory()) {
  const lines: string[] = [];
  const run = (...args: string[]) =>
    runDirectoryCommand(args, {
      directory,
      print: (line) => lines.push(line),
    });
  return { directory, lines, run, output: () => lines.join('\n') };
}

describe('directory command', () => {
  it('shows what the directory holds', async () => {
    const { directory, run, lines, output } = setup();
    await run('show');
    expect(output()).toContain('pnpm infra admin create <account>');

    await directory.createAccount({ id: 'ann', name: 'Ann A' });
    await directory.createAccount({ id: 'bob' });
    await directory.createAccount({ id: 'team' });
    await directory.addAddress('ann', 'ann@example.com');
    await directory.addAddress('bob', 'bob@example.org');
    await directory.addAddress('team', '*@example.com');
    await directory.setShare('team', 'ann', 'member');
    await directory.setShare('team', 'bob', 'reader');
    await directory.updateAccount('bob', { status: 'disabled' });
    lines.length = 0;
    await run('show');
    expect(lines).toEqual([
      'ann  (Ann A)',
      '    ann@example.com',
      'bob  [disabled]',
      '    bob@example.org',
      'team',
      '    *@example.com',
      '    shared with ann as member',
      '    shared with bob as reader',
    ]);
  });

  it('explains itself when asked for something else', async () => {
    const { run } = setup();
    await expect(run()).rejects.toThrow(UsageError);
    await expect(run('seed')).rejects.toThrow(/pnpm infra directory show/);
    await expect(run('show', 'extra')).rejects.toThrow(UsageError);
  });
});
