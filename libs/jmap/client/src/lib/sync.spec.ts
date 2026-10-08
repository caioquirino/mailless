import type { Email, Mailbox } from '@mailless/jmap-core';
import { createJmapServer } from '@mailless/jmap-server';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';
import { buildMessage } from '@mailless/jmap-server/testing';
import {
  applyQueryChanges,
  createJmapClient,
  ObjectCache,
  QueryView,
  sync,
} from '../index.js';

const BASE = 'https://mail.example.com';
const AUTH = { accountId: 'ann', username: 'ann' };

/** A real server, reached through its HTTP handler without a network. */
async function setup() {
  const server = createJmapServer({
    storage: new InMemoryStorageAdapter(),
    urls: jmapUrls(BASE),
  });
  await server.provisionAccount(AUTH);
  const handler = createFetchHandler({
    server,
    authenticate: async () => AUTH,
  });
  let posts = 0;
  const client = createJmapClient({
    sessionUrl: `${BASE}/.well-known/jmap`,
    authorization: 'Bearer good',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') posts++;
      return handler(request);
    },
  });
  let sequence = 0;
  const deliver = async (subject: string) => {
    sequence++;
    const when = new Date(Date.UTC(2026, 0, 1, 0, sequence));
    const imported = await server.importMessage(
      AUTH,
      new TextEncoder().encode(
        buildMessage({
          subject,
          text: 'Hello',
          date: when.toUTCString(),
          messageId: `<m${sequence}@example.com>`,
        }),
      ),
      {
        mailboxRole: 'inbox',
        receivedAt: when.toISOString().replace('.000', ''),
      },
    );
    return imported.id;
  };
  const inbox = (
    await client.call('Mailbox/query', { filter: { role: 'inbox' } })
  ).ids[0] as string;
  return { server, client, deliver, inbox, posts: () => posts };
}

const LIST = ['id', 'threadId', 'mailboxIds', 'keywords', 'subject'];

describe('ObjectCache', () => {
  it('holds every record of a small type, and follows what changes', async () => {
    const { client, deliver, inbox } = await setup();
    const mailboxes = new ObjectCache<Mailbox>(client, {
      type: 'Mailbox',
      everything: true,
    });
    let told = 0;
    mailboxes.subscribe(() => told++);

    expect(mailboxes.isComplete).toBe(false);
    await mailboxes.load();
    expect(mailboxes.isComplete).toBe(true);
    expect(mailboxes.get(inbox)?.unreadEmails).toBe(0);
    const before = mailboxes.values();
    expect(mailboxes.values()).toBe(before);
    expect(told).toBe(1);

    await mailboxes.sync();
    expect(told).toBe(1);
    expect(mailboxes.values()).toBe(before);

    await deliver('One');
    const made = await client.call('Mailbox/set', {
      create: { a: { name: 'Projects' } },
    });
    await mailboxes.sync();
    expect(mailboxes.get(inbox)?.unreadEmails).toBe(1);
    expect(mailboxes.get(made.created?.['a']?.id as string)?.name).toBe(
      'Projects',
    );
    expect(mailboxes.values()).not.toBe(before);

    await client.call('Mailbox/set', {
      destroy: [made.created?.['a']?.id as string],
    });
    await mailboxes.sync();
    expect(mailboxes.values().map((mailbox) => mailbox.name)).not.toContain(
      'Projects',
    );
  });

  it('holds the records asked for, and asks again only for what can change', async () => {
    const { client, deliver, posts } = await setup();
    const first = await deliver('One');
    const second = await deliver('Two');
    const emails = new ObjectCache<Email>(client, {
      type: 'Email',
      properties: LIST,
      changing: ['mailboxIds', 'keywords'],
    });

    expect(emails.ask(client.batch())).toBeNull();
    await emails.load([first]);
    expect(emails.get(first)?.subject).toBe('One');
    expect(emails.get(second)).toBeUndefined();
    const asked = posts();
    await emails.load([first]);
    expect(posts()).toBe(asked);

    // The other message changes too, and is still not held afterwards.
    await client.call('Email/set', {
      update: {
        [first]: { 'keywords/$seen': true },
        [second]: { 'keywords/$seen': true },
      },
    });
    await emails.sync();
    expect(emails.get(first)?.keywords).toEqual({ $seen: true });
    expect(emails.get(first)?.subject).toBe('One');
    expect(emails.get(second)).toBeUndefined();

    await client.call('Email/set', { destroy: [first] });
    await emails.sync();
    expect(emails.get(first)).toBeUndefined();
  });

  it('keeps more of a record when more is asked for', async () => {
    const { client, deliver } = await setup();
    const id = await deliver('One');
    const emails = new ObjectCache<Email>(client, {
      type: 'Email',
      properties: LIST,
    });
    await emails.load([id]);
    expect(emails.get(id)?.bodyValues).toBeUndefined();

    await emails.fetch([id], {
      properties: ['textBody', 'bodyValues'],
      fetchTextBodyValues: true,
    });
    const email = emails.get(id);
    expect(email?.subject).toBe('One');
    expect(Object.values(email?.bodyValues ?? {})[0]?.value).toContain('Hello');
  });

  it('shows a change before the server knows of it, and can take it back', async () => {
    const { client, deliver } = await setup();
    const id = await deliver('One');
    const emails = new ObjectCache<Email>(client, {
      type: 'Email',
      properties: LIST,
    });
    await emails.load([id]);

    const undo = emails.patch(id, { keywords: { $seen: true } });
    expect(emails.get(id)?.keywords).toEqual({ $seen: true });
    undo();
    expect(emails.get(id)?.keywords).toEqual({});

    const back = emails.remove(id);
    expect(emails.get(id)).toBeUndefined();
    back();
    expect(emails.get(id)?.subject).toBe('One');
  });

  it('takes changes a few at a time when there are many', async () => {
    const { client, deliver } = await setup();
    const mailboxes = new ObjectCache<Mailbox>(client, {
      type: 'Mailbox',
      everything: true,
      maxChanges: 2,
    });
    await mailboxes.load();
    const count = mailboxes.values().length;
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await client.call('Mailbox/set', { create: { a: { name } } });
    }
    await deliver('One');
    await mailboxes.sync();
    expect(mailboxes.values()).toHaveLength(count + 5);
  });

  it('asks for everything again when the server no longer knows what changed', async () => {
    const { client, deliver, inbox } = await setup();
    const mailboxes = new ObjectCache<Mailbox>(client, {
      type: 'Mailbox',
      everything: true,
    });
    await mailboxes.load();
    await deliver('One');
    // A state the server never gave: as when its record of changes was cut short.
    (mailboxes as unknown as { state: string }).state = 'gone';
    await mailboxes.sync();
    expect(mailboxes.get(inbox)?.unreadEmails).toBe(1);

    await deliver('Two');
    await mailboxes.sync();
    expect(mailboxes.get(inbox)?.unreadEmails).toBe(2);
  });
});

describe('QueryView', () => {
  const newestFirst = (inbox: string) => ({
    type: 'Email',
    filter: { inMailbox: inbox },
    sort: [{ property: 'receivedAt', isAscending: false }],
  });

  it('holds the top of a list, more when asked, and follows what changes', async () => {
    const { client, deliver, inbox } = await setup();
    const ids: string[] = [];
    for (const subject of ['One', 'Two', 'Three', 'Four', 'Five']) {
      ids.push(await deliver(subject));
    }
    const newest = [...ids].reverse();
    const view = new QueryView(client, { ...newestFirst(inbox), pageSize: 2 });

    expect(view.isLoaded).toBe(false);
    await view.load();
    expect(view.ids).toEqual(newest.slice(0, 2));
    expect(view.total).toBe(5);
    expect(view.hasMore).toBe(true);

    await view.loadMore();
    expect(view.ids).toEqual(newest.slice(0, 4));

    // A new message at the top, and one that is held taken away.
    const six = await deliver('Six');
    await client.call('Email/set', { destroy: [newest[1] as string] });
    await view.sync();
    expect(view.ids).toEqual([six, newest[0], newest[2], newest[3]]);
    expect(view.total).toBe(5);
    expect(view.hasMore).toBe(true);

    await view.loadMore();
    expect(view.ids).toEqual([six, newest[0], newest[2], newest[3], newest[4]]);
    expect(view.hasMore).toBe(false);
    await view.loadMore();
    expect(view.ids).toHaveLength(5);
  });

  it('asks for the list again when what arrives does not fit what is held', async () => {
    const { client, deliver, inbox } = await setup();
    const ids: string[] = [];
    for (const subject of ['One', 'Two', 'Three']) {
      ids.push(await deliver(subject));
    }
    const view = new QueryView(client, { ...newestFirst(inbox), pageSize: 2 });
    await view.load();
    const four = await deliver('Four');
    await view.loadMore();
    expect(view.ids).toEqual([four, ids[2], ids[1], ids[0]]);
    expect(view.hasMore).toBe(false);
  });

  it('is brought up to date together with the records, in one request', async () => {
    const { client, deliver, inbox, posts } = await setup();
    await deliver('One');
    const view = new QueryView(client, newestFirst(inbox));
    const mailboxes = new ObjectCache<Mailbox>(client, {
      type: 'Mailbox',
      everything: true,
    });
    const emails = new ObjectCache<Email>(client, {
      type: 'Email',
      properties: LIST,
    });
    await Promise.all([view.load(), mailboxes.load()]);
    await emails.load(view.ids);

    const two = await deliver('Two');
    const before = posts();
    await sync(client, [mailboxes, emails, view]);
    expect(posts() - before).toBe(1);
    expect(view.ids[0]).toBe(two);
    expect(mailboxes.get(inbox)?.totalEmails).toBe(2);

    const quiet = posts();
    await sync(client, [mailboxes, emails, view]);
    expect(posts() - quiet).toBe(1);
    await sync(client, []);
    expect(posts() - quiet).toBe(1);
  });
});

describe('sync', () => {
  it('asks in several requests when there is more to ask than one may hold', async () => {
    const { client, deliver, inbox, posts } = await setup();
    await deliver('One');
    const views = Array.from(
      { length: 20 },
      (_, index) =>
        new QueryView(client, {
          type: 'Email',
          filter: { inMailbox: inbox, minSize: index },
          sort: [{ property: 'receivedAt', isAscending: false }],
        }),
    );
    await Promise.all(views.map((view) => view.load()));
    const two = await deliver('Two');

    const before = posts();
    await sync(client, views);
    // Twenty calls where the server takes sixteen at a time.
    expect(posts() - before).toBe(2);
    for (const view of views) expect(view.ids[0]).toBe(two);
  });
});

describe('applyQueryChanges', () => {
  it('takes away, then puts in place', () => {
    expect(
      applyQueryChanges(
        ['a', 'b', 'c', 'd'],
        ['b', 'd'],
        [
          { id: 'd', index: 0 },
          { id: 'x', index: 2 },
        ],
      ),
    ).toEqual(['d', 'a', 'x', 'c']);
  });

  it('leaves out what belongs below the end of the list', () => {
    expect(applyQueryChanges(['a'], [], [{ id: 'z', index: 7 }])).toEqual([
      'a',
    ]);
  });
});
