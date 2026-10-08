import { InMemoryDirectory } from '@mailless/directory';
import { InMemoryIdentityProvider } from '@mailless/identity';
import { runAdminRoleCommand } from './admin-role-cli.js';
import { UsageError } from './app-password-cli.js';

const ROLE = 'MAILLESS_ADMIN';
const PASSWORD = 'correct horse battery staple';

async function setup(roles = [ROLE]) {
  const identity = new InMemoryIdentityProvider({ roles });
  await identity.createUser('ann');
  await identity.createUser('bob');
  const directory = new InMemoryDirectory();
  const lines: string[] = [];
  const run = (...args: string[]) =>
    runAdminRoleCommand(args, {
      identity,
      directory,
      role: ROLE,
      print: (line) => lines.push(line),
    });
  return { identity, directory, lines, run, output: () => lines.join('\n') };
}

describe('admin command', () => {
  it('makes an administrator, lists them, and takes the role away again', async () => {
    const { identity, run, lines, output } = await setup();
    await run('list');
    expect(output()).toContain('Nobody may administer this deployment yet.');

    await run('grant', 'ann');
    expect(output()).toContain('ann may now administer this deployment.');
    expect((await identity.getUser('ann'))?.roles).toEqual([ROLE]);

    await identity.setEnabled('ann', false);
    lines.length = 0;
    await run('list');
    expect(lines).toEqual([
      'May administer this deployment:',
      '  ann  [disabled]',
    ]);

    await run('revoke', 'ann');
    expect((await identity.getUser('ann'))?.roles).toEqual([]);
    expect((await identity.getUser('bob'))?.roles).toEqual([]);
  });

  it('ends the sessions of someone whose role is taken away', async () => {
    const { identity, run } = await setup();
    await identity.setPassword('ann', PASSWORD);
    await run('grant', 'ann');
    const token = identity.signIn('ann', PASSWORD) as string;
    await run('revoke', 'ann');
    await expect(identity.listOwnPasskeys(token)).rejects.toThrow();
  });

  it('makes the first account, with a user who may administer', async () => {
    const { identity, directory, run, output } = await setup();
    await run('create', 'root');
    expect(await directory.account('root')).toMatchObject({
      status: 'active',
    });
    expect((await identity.getUser('root'))?.roles).toEqual([ROLE]);
    expect(output()).toContain('pnpm infra password root');

    // Again, and for someone who exists already in part: nothing fails, nothing is made twice.
    await run('create', 'root');
    await run('create', 'ann');
    expect(await directory.account('ann')).toBeDefined();
    expect((await identity.getUser('ann'))?.roles).toEqual([ROLE]);

    await expect(run('create', 'Not Valid')).rejects.toThrow(UsageError);
    await expect(run('create')).rejects.toThrow(UsageError);
    expect(await directory.account('Not Valid')).toBeUndefined();
  });

  it('explains what is wrong', async () => {
    const { run } = await setup();
    await expect(run()).rejects.toThrow(UsageError);
    await expect(run('grant')).rejects.toThrow(/pnpm infra admin grant/);
    await expect(run('grant', 'ann', 'extra')).rejects.toThrow(UsageError);
    await expect(run('list', 'ann')).rejects.toThrow(UsageError);
    await expect(run('grant', 'nobody')).rejects.toThrow(
      /There is no user "nobody"/,
    );
    // The role comes with a deploy; before it, granting cannot work.
    const before = await setup([]);
    await expect(before.run('grant', 'ann')).rejects.toThrow(
      /pnpm infra apply/,
    );
  });
});
