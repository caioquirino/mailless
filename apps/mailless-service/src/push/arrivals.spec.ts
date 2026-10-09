import { createJmapServer, type JmapServer } from '@mailless/jmap-server';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';
import { buildMessage } from '@mailless/jmap-server/testing';
import { arrivals } from './arrivals.js';

const URL = 'https://jmap.example.com';
const AUTH = { accountId: 'acc-me', username: 'acc-me' };
const NOW = new Date('2026-10-09T12:00:00Z');

describe('arrivals', () => {
  let jmap: JmapServer;

  beforeEach(async () => {
    jmap = createJmapServer({
      storage: new InMemoryStorageAdapter(),
      urls: { api: URL, download: URL, upload: URL, eventSource: URL },
    });
    await jmap.provisionAccount(AUTH);
  });

  const deliver = (
    secondsAgo: number,
    message: Parameters<typeof buildMessage>[0],
    options: { mailboxRole?: string; seen?: boolean } = {},
  ) =>
    jmap.importMessage(AUTH, new TextEncoder().encode(buildMessage(message)), {
      mailboxRole: options.mailboxRole ?? 'inbox',
      delivery: true,
      receivedAt: new Date(NOW.getTime() - secondsAgo * 1000)
        .toISOString()
        .replace('.000', ''),
      ...(options.seen ? { keywords: { $seen: true } } : {}),
    });

  it('says who wrote and about what, newest first', async () => {
    await deliver(30, {
      messageId: '<a@example.com>',
      from: 'Bob Builder <bob@example.com>',
      subject: 'Plans',
      text: 'Shall we meet on Thursday?',
    });
    await deliver(5, {
      messageId: '<b@example.com>',
      from: 'carol@example.com',
      subject: 'Invoice',
      text: 'Attached.',
    });
    expect(await arrivals(jmap, AUTH.accountId, NOW)).toEqual([
      { from: 'carol@example.com', subject: 'Invoice', preview: 'Attached.' },
      {
        from: 'Bob Builder',
        subject: 'Plans',
        preview: 'Shall we meet on Thursday?',
      },
    ]);
  });

  it('leaves out what is old, read already, or not in the inbox', async () => {
    await deliver(600, { messageId: '<a@example.com>', subject: 'Old' });
    await deliver(
      5,
      { messageId: '<b@example.com>', subject: 'Read' },
      { seen: true },
    );
    await deliver(
      5,
      { messageId: '<c@example.com>', subject: 'Junk' },
      { mailboxRole: 'junk' },
    );
    expect(await arrivals(jmap, AUTH.accountId, NOW)).toEqual([]);
  });

  it('keeps to what fits in a push', async () => {
    for (let index = 0; index < 5; index++) {
      await deliver(index + 1, {
        messageId: `<m${index}@example.com>`,
        subject: 'x'.repeat(300),
        text: 'y'.repeat(900),
      });
    }
    const arrived = await arrivals(jmap, AUTH.accountId, NOW);
    expect(arrived).toHaveLength(3);
    expect(arrived[0]?.subject).toHaveLength(80);
    expect(arrived[0]?.subject.endsWith('…')).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(arrived)).length,
    ).toBeLessThan(2000);
  });
});
