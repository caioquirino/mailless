import type { JmapServer } from '@mailless/jmap-server';

/** What a notification can say of one message that arrived. */
export interface Arrival {
  /** Who it is from: their name, or their address when they gave none. */
  from: string;
  subject: string;
  /** How it begins. */
  preview: string;
}

/** The property of a push that carries them. Not part of JMAP: the webmail's worker reads it. */
export const ARRIVED = 'mailless:arrived';

/** A push is small: this many messages, each cut to what a notification shows anyway. */
const MOST = 3;
const LONGEST = { from: 40, subject: 80, preview: 100 };
/** How far back mail still counts as having just arrived. */
const JUST_NOW_MS = 2 * 60 * 1000;

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

function cut(text: unknown, longest: number): string {
  const whole = typeof text === 'string' ? text.trim() : '';
  const letters = [...whole];
  return letters.length > longest
    ? `${letters.slice(0, longest - 1).join('')}…`
    : whole;
}

/**
 * The unread messages that reached an account's inbox in the last moments,
 * newest first: what a push about new mail can tell the person. None when
 * there is no inbox, or nothing in it is that new.
 */
export async function arrivals(
  jmap: Pick<JmapServer, 'handleRequest'>,
  accountId: string,
  now: Date = new Date(),
): Promise<Arrival[]> {
  const auth = { accountId, username: accountId };
  const found = await jmap.handleRequest(
    {
      using: USING,
      methodCalls: [
        ['Mailbox/query', { accountId, filter: { role: 'inbox' } }, 'inbox'],
      ],
    },
    auth,
  );
  const [inbox] =
    (found.methodResponses[0]?.[1] as { ids?: string[] } | undefined)?.ids ??
    [];
  if (!inbox) return [];

  const read = await jmap.handleRequest(
    {
      using: USING,
      methodCalls: [
        [
          'Email/query',
          {
            accountId,
            filter: {
              operator: 'AND',
              conditions: [
                { inMailbox: inbox },
                { notKeyword: '$seen' },
                {
                  after: new Date(now.getTime() - JUST_NOW_MS)
                    .toISOString()
                    .replace(/\.\d+Z$/, 'Z'),
                },
              ],
            },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit: MOST,
          },
          'new',
        ],
        [
          'Email/get',
          {
            accountId,
            '#ids': { resultOf: 'new', name: 'Email/query', path: '/ids' },
            properties: ['from', 'subject', 'preview', 'receivedAt'],
          },
          'read',
        ],
      ],
    },
    auth,
  );
  const got = read.methodResponses.find(([name]) => name === 'Email/get');
  const emails =
    (
      got?.[1] as
        | {
            list?: Array<{
              from?: Array<{ name?: string | null; email?: string }> | null;
              subject?: string | null;
              preview?: string;
              receivedAt?: string;
            }>;
          }
        | undefined
    )?.list ?? [];
  return emails
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
    .map((email) => ({
      from: cut(
        email.from?.[0]?.name || email.from?.[0]?.email || '',
        LONGEST.from,
      ),
      subject: cut(email.subject, LONGEST.subject),
      preview: cut(email.preview, LONGEST.preview),
    }));
}
