import type { DynamoDBStreamEvent } from 'aws-lambda';
import { changedStates, pushChanges } from './state-stream.js';

function event(
  ...records: Array<[eventName: string, pk?: string, sk?: string]>
): DynamoDBStreamEvent {
  return {
    Records: records.map(([eventName, pk, sk]) => ({
      eventName,
      dynamodb: {
        Keys: {
          ...(pk === undefined ? {} : { pk: { S: pk } }),
          ...(sk === undefined ? {} : { sk: { S: sk } }),
        },
      },
    })),
  } as unknown as DynamoDBStreamEvent;
}

describe('changedStates', () => {
  it('collects the changed data types of each account', () => {
    const changes = changedStates(
      event(
        ['INSERT', 'S#acc-1', 'Email'],
        ['MODIFY', 'S#acc-1', 'Thread'],
        ['MODIFY', 'S#acc-1', 'Email'],
        ['MODIFY', 'S#user%40example.com', 'Mailbox'],
      ),
    );
    expect([...changes.keys()]).toEqual(['acc-1', 'user@example.com']);
    expect([...(changes.get('acc-1') ?? [])]).toEqual(['Email', 'Thread']);
    expect([...(changes.get('user@example.com') ?? [])]).toEqual(['Mailbox']);
  });

  it('ignores everything that is not a state item being written', () => {
    const changes = changedStates(
      event(
        ['REMOVE', 'S#acc-1', 'Email'],
        ['INSERT', 'R#acc-1#Email', 'em1'],
        ['INSERT', 'L#acc-1#Email', '0000000000000001#em1'],
        ['INSERT', 'I#acc-1#Email#threadKey#v:x', 'em1'],
        ['INSERT', 'S#acc-1'],
        ['INSERT', undefined, 'Email'],
        ['INSERT', 'S#%E0%A4%A', 'Email'],
      ),
    );
    expect(changes.size).toBe(0);
  });
});

describe('pushChanges', () => {
  it('pushes once per account and logs counts without naming anyone', async () => {
    const calls: Array<[string, readonly string[] | undefined]> = [];
    const logs: Record<string, unknown>[] = [];
    await pushChanges(
      event(
        ['MODIFY', 'S#acc-1', 'Thread'],
        ['MODIFY', 'S#acc-1', 'Email'],
        ['MODIFY', 'S#acc-2', 'AppPassword'],
      ),
      {
        jmap: {
          pushStateChange: async (accountId, types) => {
            calls.push([accountId, types]);
            return {
              sent: accountId === 'acc-1' ? 2 : 0,
              failed: 0,
              removed: 0,
            };
          },
        },
        log: (entry) => logs.push(entry),
      },
    );
    expect(calls).toEqual([
      ['acc-1', ['Thread', 'Email']],
      ['acc-2', ['AppPassword']],
    ]);
    expect(logs).toEqual([
      {
        event: 'push',
        types: ['Email', 'Thread'],
        sent: 2,
        failed: 0,
        removed: 0,
      },
      { event: 'push', types: ['AppPassword'], sent: 0, failed: 0, removed: 0 },
    ]);
    expect(JSON.stringify(logs)).not.toContain('acc-');
  });

  it('adds what arrived to a push about new mail, and to no other, and logs none of it', async () => {
    const calls: unknown[] = [];
    const asked: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const arrived = [{ from: 'Bob', subject: 'Plans', preview: 'Shall we?' }];
    await pushChanges(
      event(
        ['MODIFY', 'S#acc-1', 'EmailDelivery'],
        ['MODIFY', 'S#acc-2', 'Email'],
        ['MODIFY', 'S#acc-3', 'EmailDelivery'],
      ),
      {
        jmap: {
          pushStateChange: async (accountId, types, extra) => {
            calls.push([accountId, types, extra]);
            return { sent: 1, failed: 0, removed: 0 };
          },
        },
        arrived: async (accountId) => {
          asked.push(accountId);
          // Not being able to say what arrived does not stop the push.
          if (accountId === 'acc-3') throw new Error('table unavailable');
          return arrived;
        },
        log: (entry) => logs.push(entry),
      },
    );
    expect(asked).toEqual(['acc-1', 'acc-3']);
    expect(calls).toEqual([
      ['acc-1', ['EmailDelivery'], { 'mailless:arrived': arrived }],
      ['acc-2', ['Email'], undefined],
      ['acc-3', ['EmailDelivery'], undefined],
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/Bob|Plans|Shall/);
  });

  it('lets a failure on our side reach the caller, so the batch is retried', async () => {
    await expect(
      pushChanges(event(['MODIFY', 'S#acc-1', 'Email']), {
        jmap: {
          pushStateChange: async () => {
            throw new Error('table unavailable');
          },
        },
      }),
    ).rejects.toThrow('table unavailable');
  });
});
