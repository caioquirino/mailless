import { createAppPasswordStore } from '@mailless/app-passwords';
import { InMemoryMetadataStore } from '@mailless/jmap-server/memory';
import { runAppPasswordCommand, UsageError } from './app-password-cli.js';

function setup(accounts = ['me']) {
  const store = createAppPasswordStore(new InMemoryMetadataStore());
  const lines: string[] = [];
  const run = (...args: string[]) =>
    runAppPasswordCommand(args, {
      store,
      accounts,
      print: (line) => lines.push(line),
    });
  return { store, lines, run, output: () => lines.join('\n') };
}

describe('app-password command', () => {
  it('creates a password, shows it once, and it then signs in', async () => {
    const { run, store, output } = setup();
    await run('create', 'Mailtemi', 'on', 'phone');
    const secret = /mlapp-[a-z2-7-]+/.exec(output())?.[0] ?? '';
    expect(secret).toMatch(/^mlapp-([a-z2-7]{5}-){5}[a-z2-7]{5}$/);
    expect(output()).toContain('"Mailtemi on phone"');
    expect(output()).toContain('shown only this once');
    expect((await store.verify('me', secret))?.label).toBe('Mailtemi on phone');
  });

  it('lists passwords without revealing them and revokes by id', async () => {
    const { run, store, lines, output } = setup();
    await run('list');
    expect(output()).toContain('has no app passwords');

    const created = await store.create('me', 'Laptop');
    lines.length = 0;
    await run('list');
    expect(output()).toContain(created.id);
    expect(output()).toContain('Laptop');
    expect(output()).toContain('never used');
    expect(output()).not.toContain('mlapp-');

    await run('revoke', created.id);
    expect(await store.verify('me', created.secret)).toBeNull();
    await expect(run('revoke', created.id)).rejects.toBeInstanceOf(UsageError);
  });

  it('needs the account named when there are several, and refuses unknown ones', async () => {
    const { run, store } = setup(['me', 'you']);
    await expect(run('create', 'Phone')).rejects.toThrow(/--account/);
    await expect(run('create', 'Phone', '--account', 'typo')).rejects.toThrow(
      /no account "typo"/,
    );
    await expect(run('list', '--account')).rejects.toBeInstanceOf(UsageError);

    await run('create', '--account', 'you', 'Phone');
    expect((await store.list('you')).map((entry) => entry.label)).toEqual([
      'Phone',
    ]);
    expect(await store.list('me')).toEqual([]);
  });

  it('explains itself when used wrongly', async () => {
    const { run } = setup();
    await expect(run()).rejects.toThrow(/Usage:/);
    await expect(run('destroy')).rejects.toThrow(/Usage:/);
    await expect(run('create')).rejects.toThrow(/label/);
    await expect(run('revoke')).rejects.toThrow(/which password/);
  });
});
