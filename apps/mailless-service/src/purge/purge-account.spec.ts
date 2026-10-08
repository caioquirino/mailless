import { InMemoryDirectory } from '@mailless/directory';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';
import { purgeAccounts } from './purge-account.js';

const encoder = new TextEncoder();

async function setup(options: { keepGoing?: () => boolean } = {}) {
  const directory = new InMemoryDirectory();
  const storage = new InMemoryStorageAdapter();
  for (const id of ['gone', 'kept']) {
    await directory.createAccount({ id });
    await storage.metadata.commit(id, [
      { kind: 'create', type: 'Email', id: 'e1', value: {} },
    ]);
    await storage.blobs.put(id, 'b1', encoder.encode('a message'));
  }
  await directory.updateAccount('gone', { status: 'deleting' });

  const continued: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const run = (event: Parameters<typeof purgeAccounts>[0]) =>
    purgeAccounts(event, {
      directory,
      storage,
      keepGoing: options.keepGoing ?? (() => true),
      continueLater: async (accountId) => {
        continued.push(accountId);
      },
      log: (entry) => logs.push(entry),
    });
  const has = async (id: string) =>
    (await storage.metadata.list(id, 'Email')).length > 0 ||
    (await storage.blobs.get(id, 'b1')) !== null;
  return { directory, run, has, continued, logs };
}

describe('purgeAccounts', () => {
  it('removes what a closed account had, and then the account', async () => {
    const { directory, run, has, logs } = await setup();
    expect(await run({ Records: [{ body: '{"accountId":"gone"}' }] })).toEqual([
      'done',
    ]);
    expect(await has('gone')).toBe(false);
    expect(await directory.account('gone')).toBeUndefined();
    expect(await has('kept')).toBe(true);
    expect(logs).toEqual([
      { event: 'purge', account: 'gone', outcome: 'done' },
    ]);
  });

  it('touches nothing of an account the directory does not say is closed', async () => {
    const { directory, run, has } = await setup();
    expect(await run({ accountId: 'kept' })).toEqual(['not-closed']);
    expect(await has('kept')).toBe(true);
    expect((await directory.account('kept'))?.status).toBe('active');

    await directory.updateAccount('kept', { status: 'disabled' });
    expect(await run({ accountId: 'kept' })).toEqual(['not-closed']);
    expect(await has('kept')).toBe(true);
  });

  it('has nothing to do for an account that is not there', async () => {
    const { run, continued } = await setup();
    expect(await run({ accountId: 'nobody' })).toEqual(['no-account']);
    expect(continued).toEqual([]);
  });

  it('drops a request that makes no sense', async () => {
    const { run, has } = await setup();
    expect(
      await run({
        Records: [
          { body: 'not json' },
          { body: '{"accountId":5}' },
          { body: '{"accountId":"Gone/../kept"}' },
        ],
      }),
    ).toEqual(['malformed', 'malformed', 'malformed']);
    expect(await run({})).toEqual(['malformed']);
    expect(await has('gone')).toBe(true);
  });

  it('hands over to another run when time runs out, and keeps the account listed', async () => {
    const { directory, run, continued } = await setup({
      keepGoing: () => false,
    });
    expect(await run({ accountId: 'gone' })).toEqual(['continued']);
    expect(continued).toEqual(['gone']);
    expect((await directory.account('gone'))?.status).toBe('deleting');
  });

  it('fails, to be tried again, when storage fails', async () => {
    const { directory, run } = await setup({
      keepGoing: () => {
        throw new Error('throttled');
      },
    });
    await expect(run({ accountId: 'gone' })).rejects.toThrow('throttled');
    expect((await directory.account('gone'))?.status).toBe('deleting');
  });
});
