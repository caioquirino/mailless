import { sendScheduled } from './scheduled-send.js';

function setup(outcome: string | Error = 'sent') {
  const calls: Array<[string, string]> = [];
  const logs: Record<string, unknown>[] = [];
  const run = (event: Parameters<typeof sendScheduled>[0]) =>
    sendScheduled(event, {
      jmap: {
        sendScheduled: async (auth, submissionId) => {
          calls.push([auth.accountId, submissionId]);
          if (outcome instanceof Error) throw outcome;
          return outcome as never;
        },
      },
      log: (entry) => logs.push(entry),
    });
  return { run, calls, logs };
}

describe('sendScheduled', () => {
  it('sends what a schedule names', async () => {
    const { run, calls, logs } = setup();
    await run({ accountId: 'acc-1', submissionId: 'es1' });
    expect(calls).toEqual([['acc-1', 'es1']]);
    expect(logs).toEqual([
      { event: 'scheduled-send', submissionId: 'es1', outcome: 'sent' },
    ]);
  });

  it('sends what queue messages name', async () => {
    const { run, calls } = setup('not-pending');
    await run({
      Records: [
        { body: '{"accountId":"acc-1","submissionId":"es1"}' },
        { body: '{"accountId":"acc-2","submissionId":"es2"}' },
      ],
    });
    expect(calls).toEqual([
      ['acc-1', 'es1'],
      ['acc-2', 'es2'],
    ]);
  });

  it('drops a wake-up that makes no sense', async () => {
    const { run, calls, logs } = setup();
    await run({ Records: [{ body: 'not json' }, { body: '{"accountId":5}' }] });
    await run({ accountId: 'acc 1', submissionId: 'es1' });
    await run({});
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(4);
    expect(logs.every((entry) => entry['outcome'] === 'malformed')).toBe(true);
  });

  it('fails, to be tried again, when sending failed or someone else is at it', async () => {
    await expect(
      setup(new Error('connection reset')).run({
        accountId: 'acc-1',
        submissionId: 'es1',
      }),
    ).rejects.toThrow('connection reset');
    await expect(
      setup('in-progress').run({ accountId: 'acc-1', submissionId: 'es1' }),
    ).rejects.toThrow(/still being sent/);
  });
});
