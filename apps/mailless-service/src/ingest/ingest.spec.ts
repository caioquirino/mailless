import { InMemoryDirectory } from '@mailless/directory';
import { createJmapServer, type JmapServer } from '@mailless/jmap-server';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';
import { buildMessage } from '@mailless/jmap-server/testing';
import type { SESEvent } from 'aws-lambda';
import { ingest, type InboundStore } from './ingest.js';

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const URL = 'https://jmap.example.com';
const directory = await InMemoryDirectory.from({
  mailboxes: {
    'Me@Example.com': 'acc-me',
    'alias@example.com': 'acc-me',
    '*@team.example.com': 'acc-team',
  },
});

function sesEvent(
  messageId: string,
  recipients: string[],
  verdicts: {
    spam?: string;
    virus?: string;
    spf?: string;
    dkim?: string;
    dmarc?: string;
    dmarcPolicy?: string;
  } = {},
): SESEvent {
  return {
    Records: [
      {
        eventSource: 'aws:ses',
        eventVersion: '1.0',
        ses: {
          mail: { messageId, timestamp: '2026-10-07T09:30:00.000Z' },
          receipt: {
            recipients,
            spamVerdict: { status: verdicts.spam ?? 'PASS' },
            virusVerdict: { status: verdicts.virus ?? 'PASS' },
            spfVerdict: { status: verdicts.spf ?? 'PASS' },
            dkimVerdict: { status: verdicts.dkim ?? 'PASS' },
            dmarcVerdict: { status: verdicts.dmarc ?? 'PASS' },
            ...(verdicts.dmarcPolicy
              ? { dmarcPolicy: verdicts.dmarcPolicy }
              : {}),
          },
        },
      },
    ],
  } as unknown as SESEvent;
}

describe('ingest', () => {
  let jmap: JmapServer;
  let objects: Map<string, Uint8Array>;
  let inbound: InboundStore;

  beforeEach(() => {
    jmap = createJmapServer({
      storage: new InMemoryStorageAdapter(),
      urls: { api: URL, download: URL, upload: URL, eventSource: URL },
    });
    objects = new Map();
    inbound = {
      get: async (id) => objects.get(id) ?? null,
      delete: async (id) => void objects.delete(id),
    };
  });

  const run = (
    event: SESEvent,
    server: Pick<JmapServer, 'importMessage' | 'provisionAccount'> = jmap,
  ) =>
    ingest(event, {
      jmap: server,
      inbound,
      resolveAccount: (recipient) => directory.resolveAddress(recipient),
    });

  const store = (id: string, subject = 'Hello') =>
    objects.set(id, new TextEncoder().encode(buildMessage({ subject })));

  const emails = async (accountId: string) => {
    const auth = { accountId, username: 'x' };
    const response = await jmap.handleRequest(
      {
        using: USING,
        methodCalls: [
          ['Email/query', { accountId }, 'q'],
          [
            'Email/get',
            {
              accountId,
              '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
              properties: ['subject', 'mailboxIds', 'keywords', 'receivedAt'],
            },
            'g',
          ],
          ['Mailbox/get', { accountId, properties: ['role'] }, 'm'],
        ],
      },
      auth,
    );
    const list = (
      response.methodResponses[1]?.[1] as { list: Record<string, unknown>[] }
    ).list;
    const roles = new Map(
      (
        response.methodResponses[2]?.[1] as {
          list: { id: string; role: string }[];
        }
      ).list.map((mailbox) => [mailbox.id, mailbox.role]),
    );
    return list.map((email) => ({
      subject: email['subject'],
      receivedAt: email['receivedAt'],
      keywords: email['keywords'],
      roles: Object.keys(email['mailboxIds'] as object).map((id) =>
        roles.get(id),
      ),
    }));
  };

  it('delivers to the inbox of a new account and removes the inbound object', async () => {
    store('m1', 'First');
    expect(await run(sesEvent('m1', ['ME@example.com']))).toEqual([
      'delivered',
    ]);
    expect(await emails('acc-me')).toEqual([
      {
        subject: 'First',
        receivedAt: '2026-10-07T09:30:00Z',
        keywords: {},
        roles: ['inbox'],
      },
    ]);
    expect(objects.size).toBe(0);
  });

  it('delivers once per account and to every account addressed', async () => {
    store('m2');
    await run(
      sesEvent('m2', [
        'me@example.com',
        'alias@example.com',
        'dev@team.example.com',
        'nobody@other.com',
      ]),
    );
    expect(await emails('acc-me')).toHaveLength(1);
    expect(await emails('acc-team')).toHaveLength(1);
  });

  it('sets aside mail that fails its domain’s own check, when the domain asks for that', async () => {
    store('f1');
    await run(
      sesEvent('f1', ['me@example.com'], {
        dmarc: 'FAIL',
        dmarcPolicy: 'reject',
      }),
    );
    expect(await emails('acc-me')).toMatchObject([
      { roles: ['junk'], keywords: { $junk: true, $phishing: true } },
    ]);
  });

  it('delivers mail that fails a check its domain only watches, with a warning on it', async () => {
    store('f2');
    await run(
      sesEvent('f2', ['me@example.com'], {
        dmarc: 'FAIL',
        dmarcPolicy: 'none',
      }),
    );
    expect(await emails('acc-me')).toMatchObject([
      { roles: ['inbox'], keywords: { $phishing: true } },
    ]);
  });

  it('marks mail nothing vouches for, and no other', async () => {
    store('f3');
    await run(
      sesEvent('f3', ['me@example.com'], {
        spf: 'FAIL',
        dkim: 'GRAY',
        dmarc: 'GRAY',
      }),
    );
    expect(await emails('acc-me')).toMatchObject([
      { roles: ['inbox'], keywords: { 'mailless-unverified': true } },
    ]);

    // Signed by nobody, and sent from where its envelope says: something vouches for it.
    store('f4');
    await run(
      sesEvent('f4', ['alias@example.com'], { dkim: 'GRAY', dmarc: 'GRAY' }),
    );
    // The checks did not run: nothing is known, and nothing is said.
    store('f5');
    await run(
      sesEvent('f5', ['me@example.com'], {
        spf: 'DISABLED',
        dkim: 'DISABLED',
        dmarc: 'DISABLED',
      }),
    );
    const marked = (await emails('acc-me')).filter(
      (email) => Object.keys(email.keywords as object).length > 0,
    );
    expect(marked).toHaveLength(1);
  });

  it('files spam under Junk with the $junk keyword', async () => {
    store('m3');
    await run(sesEvent('m3', ['me@example.com'], { spam: 'FAIL' }));
    expect(await emails('acc-me')).toMatchObject([
      { roles: ['junk'], keywords: { $junk: true } },
    ]);
  });

  it('discards messages that failed the virus scan', async () => {
    store('m4');
    expect(
      await run(sesEvent('m4', ['me@example.com'], { virus: 'FAIL' })),
    ).toEqual(['discarded-virus']);
    expect(objects.size).toBe(0);
    expect(await emails('acc-me')).toEqual([]);
  });

  it('drops mail for addresses nobody owns', async () => {
    store('m5');
    expect(await run(sesEvent('m5', ['stranger@example.com']))).toEqual([
      'no-recipient',
    ]);
    expect(objects.size).toBe(0);
  });

  it('reports a missing object without failing', async () => {
    expect(await run(sesEvent('gone', ['me@example.com']))).toEqual([
      'missing-object',
    ]);
  });

  it('keeps unparseable content for inspection and does not retry', async () => {
    objects.set('m6', new TextEncoder().encode('not a message'));
    expect(await run(sesEvent('m6', ['me@example.com']))).toEqual([
      'invalid-message',
    ]);
    expect(objects.has('m6')).toBe(true);
  });

  it('does not duplicate mail when an invocation is retried after a partial failure', async () => {
    store('m7');
    let calls = 0;
    const flaky: Pick<JmapServer, 'importMessage' | 'provisionAccount'> = {
      provisionAccount: (auth) => jmap.provisionAccount(auth),
      importMessage: (auth, raw, options) => {
        calls += 1;
        if (calls === 2) throw new Error('storage unavailable');
        return jmap.importMessage(auth, raw, options);
      },
    };
    const event = sesEvent('m7', ['me@example.com', 'dev@team.example.com']);

    await expect(run(event, flaky)).rejects.toThrow('storage unavailable');
    expect(objects.has('m7')).toBe(true);

    expect(await run(event, flaky)).toEqual(['delivered']);
    expect(await emails('acc-me')).toHaveLength(1);
    expect(await emails('acc-team')).toHaveLength(1);
    expect(objects.size).toBe(0);
  });
});
