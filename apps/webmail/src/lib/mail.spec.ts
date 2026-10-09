import { fakeBackend, testStore } from '../test-support';
import { MailError, type Draft } from './mail';

const draft = (changes: Partial<Draft> = {}): Draft => ({
  identityId: 'ann',
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Lunch',
  html: '<p>Thursday?</p>',
  attachments: [],
  ...changes,
});

describe('MailStore', () => {
  it('knows the mailboxes and who the user may write as from the start', async () => {
    const store = await testStore(await fakeBackend());
    expect(store.mailbox('inbox')?.name).toEqual(expect.any(String));
    expect(store.mailbox('trash')).toBeDefined();
    expect(store.identities.values().map((identity) => identity.email)).toEqual(
      ['ann@example.com'],
    );
  });

  it('opens a mailbox with its conversations in one request', async () => {
    const backend = await fakeBackend();
    const first = await backend.deliver({ subject: 'Plans' });
    await backend.deliver({ subject: 'Other' });
    const reply = await backend.deliver({
      subject: 'Re: Plans',
      inReplyTo: '<m1@example.com>',
      references: '<m1@example.com>',
    });
    const store = await testStore(backend);
    const inbox = store.mailbox('inbox')?.id as string;
    const view = store.list({ mailboxId: inbox });

    const before = backend.state.posts;
    await store.open(view);
    expect(backend.state.posts - before).toBe(1);
    // Two conversations: the newest message stands for each.
    expect(view.ids).toHaveLength(2);
    expect(view.ids[0]).toBe(reply);
    const threadId = store.emails.get(reply)?.threadId as string;
    expect(store.conversation(threadId).map((email) => email.id)).toEqual([
      first,
      reply,
    ]);
    expect(store.list({ mailboxId: inbox })).toBe(view);

    await store.open(view);
    expect(backend.state.posts - before).toBe(1);
  });

  it('follows what arrives and what changes elsewhere', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'One' });
    const store = await testStore(backend);
    const inbox = store.mailbox('inbox')?.id as string;
    const view = store.list({ mailboxId: inbox });
    await store.open(view);

    const two = await backend.deliver({ subject: 'Two' });
    await store.refresh();
    expect(view.ids[0]).toBe(two);
    expect(store.emails.get(two)?.subject).toBe('Two');
    expect(
      store.threads.get(store.emails.get(two)?.threadId as string),
    ).toBeDefined();
    expect(store.mailbox('inbox')?.unreadEmails).toBe(2);
  });

  it('reads a conversation: the text of each message, and marks it read', async () => {
    const backend = await fakeBackend();
    const id = await backend.deliver({
      subject: 'Hello',
      text: 'Plain words',
      html: '<p>Rich <b>words</b></p>',
    });
    const store = await testStore(backend);
    const view = store.list({
      mailboxId: store.mailbox('inbox')?.id as string,
    });
    await store.open(view);
    const threadId = store.emails.get(id)?.threadId as string;

    await store.read(threadId);
    const email = store.emails.get(id);
    const part = email?.htmlBody?.[0];
    expect(part?.type).toBe('text/html');
    expect(email?.bodyValues?.[part?.partId as string]?.value).toContain(
      '<b>words</b>',
    );

    await store.setKeyword([id], '$seen', true);
    expect(store.emails.get(id)?.keywords).toEqual({ $seen: true });
    expect(store.mailbox('inbox')?.unreadEmails).toBe(0);
    // The text is still held after the change came back from the server.
    expect(store.emails.get(id)?.bodyValues).toBeDefined();
  });

  it('moves to the trash, and from the trash removes for good', async () => {
    const backend = await fakeBackend();
    const id = await backend.deliver({ subject: 'Old' });
    const store = await testStore(backend);
    const inbox = store.mailbox('inbox')?.id as string;
    const trash = store.mailbox('trash')?.id as string;
    const view = store.list({ mailboxId: inbox });
    await store.open(view);

    const removing = store.remove([id]);
    // Gone from the list at once, before the server has answered.
    expect(view.ids).toEqual([]);
    await removing;
    expect(store.emails.get(id)?.mailboxIds).toEqual({ [trash]: true });
    expect(store.mailbox('trash')?.totalEmails).toBe(1);

    const binned = store.list({ mailboxId: trash });
    await store.open(binned);
    expect(binned.ids).toEqual([id]);
    await store.remove([id]);
    expect(binned.ids).toEqual([]);
    expect(store.emails.get(id)).toBeUndefined();
    expect(store.mailbox('trash')?.totalEmails).toBe(0);
  });

  it('moves between mailboxes, and empties one', async () => {
    const backend = await fakeBackend();
    const ids = [
      await backend.deliver({ subject: 'One' }),
      await backend.deliver({ subject: 'Two' }),
    ];
    const store = await testStore(backend);
    const inbox = store.mailbox('inbox')?.id as string;
    const projects = await store.createMailbox('Projects');
    expect(store.mailboxes.get(projects)?.name).toBe('Projects');
    await expect(store.createMailbox('Projects')).rejects.toThrow(MailError);

    await store.open(store.list({ mailboxId: inbox }));
    await store.move(ids, projects, inbox);
    expect(store.mailboxes.get(projects)?.totalEmails).toBe(2);
    expect(store.mailbox('inbox')?.totalEmails).toBe(0);

    expect(await store.empty(projects)).toBe(2);
    expect(store.mailboxes.get(projects)?.totalEmails).toBe(0);
  });

  it('keeps only the lists looked at lately in step, whatever number were opened', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'One' });
    const store = await testStore(backend);
    const inbox = store.list({
      mailboxId: store.mailbox('inbox')?.id as string,
    });
    await store.open(inbox);
    const searches = [];
    for (let index = 0; index < 30; index++) {
      const found = store.list({ search: `word${index}` });
      await store.open(found);
      searches.push(found);
      // The inbox is gone back to in between, as someone searching does.
      store.list({ mailboxId: store.mailbox('inbox')?.id as string });
    }
    const two = await backend.deliver({ subject: 'Two word0 word29' });

    const before = backend.state.posts;
    await store.refresh();
    expect(inbox.ids[0]).toBe(two);
    expect(searches[29]?.ids).toEqual([two]);
    // Let go long ago, and not asked about again.
    expect(searches[0]?.ids).toEqual([]);
    expect(backend.state.posts - before).toBeLessThanOrEqual(3);
    // Returned to, it is loaded afresh.
    const again = store.list({ search: 'word0' });
    expect(again).not.toBe(searches[0]);
    await store.open(again);
    expect(again.ids).toEqual([two]);
  });

  it('finds messages by what they say', async () => {
    const backend = await fakeBackend();
    const id = await backend.deliver({
      subject: 'Invoice',
      text: 'Amount due',
    });
    await backend.deliver({ subject: 'Hello', text: 'Nothing' });
    const store = await testStore(backend);
    const found = store.list({ search: 'invoice' });
    await store.open(found);
    expect(found.ids).toEqual([id]);
  });

  it('sends a message, files it under Sent and marks what it answers', async () => {
    const backend = await fakeBackend();
    const original = await backend.deliver({ subject: 'Lunch?' });
    const store = await testStore(backend);
    await store.open(
      store.list({ mailboxId: store.mailbox('inbox')?.id as string }),
    );

    await store.send(
      draft({
        subject: 'Re: Lunch?',
        inReplyTo: ['m1@example.com'],
        references: ['m1@example.com'],
        answers: { emailId: original, keyword: '$answered' },
      }),
    );
    expect(backend.sent).toHaveLength(1);
    expect(backend.sent[0]?.recipients).toEqual(['bob@example.com']);
    expect(backend.sent[0]?.message).toContain('Thursday?');
    expect(backend.sent[0]?.message).toMatch(/^From: .*ann@example\.com/m);
    expect(store.mailbox('sent')?.totalEmails).toBe(1);
    expect(store.mailbox('drafts')?.totalEmails).toBe(0);
    expect(store.emails.get(original)?.keywords['$answered']).toBe(true);
  });

  it('keeps a draft, and replaces it when it is kept again or sent', async () => {
    const backend = await fakeBackend();
    const store = await testStore(backend);
    const { id: first } = await store.saveDraft(draft());
    expect(store.mailbox('drafts')?.totalEmails).toBe(1);
    const { id: second } = await store.saveDraft(
      draft({ html: '<p>Friday?</p>', replaces: first }),
    );
    expect(second).not.toBe(first);
    expect(store.mailbox('drafts')?.totalEmails).toBe(1);

    await store.send(draft({ html: '<p>Friday?</p>', replaces: second }));
    expect(store.mailbox('drafts')?.totalEmails).toBe(0);
    expect(backend.sent[0]?.message).toContain('Friday?');
  });

  it('knows how full the mailbox is', async () => {
    const backend = await fakeBackend();
    await backend.deliver({ subject: 'Hello' });
    const store = await testStore(backend);
    const usage = await store.usage();
    expect(usage?.limit).toBe(1024 ** 3);
    expect(usage?.used).toBeGreaterThan(0);
  });

  it('says so when there is nobody to send to', async () => {
    const store = await testStore(await fakeBackend());
    await expect(store.send(draft({ to: [] }))).rejects.toThrow(
      'Say who the message is for.',
    );
  });
});
