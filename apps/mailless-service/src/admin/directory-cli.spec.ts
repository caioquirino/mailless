import { InMemoryDirectory } from '@mailless/directory';
import { UsageError } from './app-password-cli.js';
import { runDirectoryCommand } from './directory-cli.js';

const configuration = {
  mailboxes: {
    'Ann@example.com': 'ann',
    '*@example.com': 'team',
    'bob@example.org': 'bob',
  },
  names: { ann: 'Ann A' },
  shares: { team: { members: ['ann'], readers: ['ann', 'bob', 'team'] } },
};

function setup(directory = new InMemoryDirectory()) {
  const lines: string[] = [];
  const run = (...args: string[]) =>
    runDirectoryCommand(args, {
      directory,
      configuration,
      print: (line) => lines.push(line),
    });
  return { directory, lines, run, output: () => lines.join('\n') };
}

describe('directory command', () => {
  it('copies the configured accounts into an empty directory', async () => {
    const { directory, run, output } = setup();
    expect(await run('seed')).toBe(true);
    expect(output()).toContain('Added 8 entries');
    expect(output()).toContain(
      '3 of 3 configured addresses deliver to the same account',
    );
    expect(output()).toContain('The directory matches the configuration.');

    expect(await directory.resolveAddress('ann@example.com')).toBe('ann');
    expect(await directory.resolveAddress('other@example.com')).toBe('team');
    expect(await directory.account('ann')).toMatchObject({ name: 'Ann A' });
    expect(await directory.sharesOf('team')).toEqual({
      ann: 'member',
      bob: 'reader',
    });
  });

  it('adds nothing when run again', async () => {
    const { run, lines, output } = setup();
    await run('seed');
    lines.length = 0;
    expect(await run('seed')).toBe(true);
    expect(output()).toContain('Added 0 entries');
    expect(output()).toContain('The directory matches the configuration.');
  });

  it('leaves what the directory already says, and reports each difference', async () => {
    const directory = new InMemoryDirectory();
    await directory.createAccount({ id: 'ann', name: 'Someone Else' });
    await directory.createAccount({ id: 'cat' });
    await directory.createAccount({ id: 'team' });
    await directory.addAddress('cat', 'bob@example.org');
    await directory.setShare('team', 'ann', 'reader');
    const { run, output } = setup(directory);

    expect(await run('seed')).toBe(false);
    expect(output()).toContain('Left as it is');
    expect(output()).toContain('account ann: named "Someone Else"');
    expect(output()).toContain(
      'address bob@example.org: delivers to cat in the directory, to bob in the configuration',
    );
    expect(output()).toContain(
      'share of team with ann: reader in the directory, member in the configuration',
    );
    expect(output()).toContain('2 of 3 configured addresses');
    // Nothing that was there has been replaced.
    expect(await directory.account('ann')).toMatchObject({
      name: 'Someone Else',
    });
    expect(await directory.resolveAddress('bob@example.org')).toBe('cat');
    expect((await directory.sharesOf('team'))['ann']).toBe('reader');
  });

  it('shows what the directory holds', async () => {
    const { directory, run, lines, output } = setup();
    await run('show');
    expect(output()).toContain('The directory is empty');

    await run('seed');
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
    await expect(run('remove')).rejects.toThrow(/pnpm infra directory seed/);
    await expect(run('seed', 'extra')).rejects.toThrow(UsageError);
  });
});
