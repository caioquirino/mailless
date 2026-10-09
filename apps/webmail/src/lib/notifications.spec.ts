import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fakeBackend,
  fakeBrowser,
  PUSH_ENDPOINT as ENDPOINT,
  testStore,
} from '../test-support';
import { MailError } from './mail';
import { answerPushes, Notifications } from './notifications';

const KEY = 'mailless.mail.push';

async function setup(options: { verify?: boolean } = {}) {
  const backend = await fakeBackend();
  const store = await testStore(backend);
  const browser = fakeBrowser(backend, options);
  const make = () =>
    new Notifications({ client: store.client, ...browser.deps });
  const subscriptions = async () =>
    (
      (await store.client.call('PushSubscription/get', { ids: null })) as {
        list: Array<{
          id: string;
          types: string[] | null;
          verificationCode: string | null;
          expires: string;
        }>;
      }
    ).list;
  return { backend, store, browser, make, subscriptions };
}

describe('Notifications', () => {
  it('is off until asked for, and cannot be had where the browser has none', async () => {
    const { store, browser, make } = await setup();
    const notifications = make();
    await notifications.start();
    expect(notifications.state).toBe('off');
    expect(browser.state.asked).toBe(0);

    const without = new Notifications({
      client: store.client,
      ...browser.deps,
      serviceWorker: undefined,
    });
    expect(without.state).toBe('unsupported');
    await expect(without.enable()).rejects.toThrow(MailError);
  });

  it('turns on: asks the person, registers with the server and proves pushes arrive', async () => {
    const { browser, make, subscriptions } = await setup();
    const notifications = make();
    const states: string[] = [];
    notifications.subscribe(() => states.push(notifications.state));

    await notifications.enable();
    expect(notifications.state).toBe('on');
    expect(states).toEqual(['on']);
    expect(browser.state.asked).toBe(1);
    expect(browser.state.registered).toEqual([
      'https://mail.example.com/mail/sw.js',
    ]);
    // Signed with the server's own key, and one notification for every push.
    expect(browser.state.subscribedWith?.userVisibleOnly).toBe(true);
    expect(
      (browser.state.subscribedWith?.applicationServerKey as Uint8Array).length,
    ).toBe(65);

    const [made] = await subscriptions();
    // When mail is delivered and when a reminder is due, and confirmed with the code the test push carried.
    expect(made?.types).toEqual(['EmailDelivery', 'CalendarAlert']);
    expect(made?.verificationCode).toEqual(expect.any(String));
    expect(browser.pushes[0]?.['@type']).toBe('PushVerification');
    expect(
      JSON.parse(window.localStorage.getItem(KEY) as string),
    ).toMatchObject({
      id: made?.id,
      endpoint: ENDPOINT,
      username: 'ann@example.com',
    });
    // Nobody is left listening for a test push.
    expect(browser.listeners.size).toBe(0);
  });

  it('is told when mail is delivered, and not when something else changes', async () => {
    const { backend, browser, make, store } = await setup();
    await make().enable();
    browser.pushes.length = 0;

    const id = await backend.deliver({ subject: 'Hello' });
    await backend.push.flush();
    expect(browser.pushes).toHaveLength(1);
    expect(browser.pushes[0]?.['@type']).toBe('StateChange');

    await store.client.call('Email/set', {
      update: { [id]: { 'keywords/$seen': true } },
    });
    await backend.push.flush();
    expect(browser.pushes).toHaveLength(1);
  });

  it('stays off when the person says no, and says how to change that', async () => {
    const { browser, make, subscriptions } = await setup();
    browser.state.answer = 'denied';
    const notifications = make();
    await expect(notifications.enable()).rejects.toThrow(/blocked/);
    expect(notifications.state).toBe('blocked');
    expect(await subscriptions()).toEqual([]);
    expect(browser.state.subscribed).toBe(false);
  });

  it('leaves nothing behind when the test push never arrives', async () => {
    const { browser, make, subscriptions } = await setup({ verify: false });
    const notifications = make();
    await expect(notifications.enable()).rejects.toThrow(
      /test notification did not arrive/,
    );
    expect(notifications.state).toBe('off');
    expect(await subscriptions()).toEqual([]);
    expect(browser.state.subscribed).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('picks up after a reload what was chosen before', async () => {
    const { browser, make, subscriptions } = await setup();
    await make().enable();
    const [before] = await subscriptions();

    const again = make();
    await again.start();
    expect(again.state).toBe('on');
    expect((await subscriptions()).map((each) => each.id)).toEqual([
      before?.id,
    ]);
    expect(browser.state.asked).toBe(1);
  });

  it('is told of reminders too, when it was made before there were any', async () => {
    const { store, make, subscriptions } = await setup();
    await make().enable();
    const [before] = await subscriptions();
    await store.client.call('PushSubscription/set', {
      update: { [before?.id as string]: { types: ['EmailDelivery'] } },
    });

    await make().start();
    const [after] = await subscriptions();
    expect(after?.id).toBe(before?.id);
    expect(after?.types).toEqual(['EmailDelivery', 'CalendarAlert']);
  });

  it('makes it again when the server has let go of it', async () => {
    const { store, make, subscriptions } = await setup();
    await make().enable();
    const [before] = await subscriptions();
    await store.client.call('PushSubscription/set', {
      destroy: [before?.id as string],
    });

    const again = make();
    await again.start();
    expect(again.state).toBe('on');
    const [after] = await subscriptions();
    expect(after?.id).not.toBe(before?.id);
    expect(after?.verificationCode).toEqual(expect.any(String));
  });

  it('turns off at both ends', async () => {
    const { browser, make, subscriptions } = await setup();
    const notifications = make();
    await notifications.enable();
    await notifications.disable();
    expect(notifications.state).toBe('off');
    expect(await subscriptions()).toEqual([]);
    expect(browser.state.subscribed).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('does not announce one person’s mail to the next who signs in here', async () => {
    const { browser, make } = await setup();
    await make().enable();
    const kept = JSON.parse(window.localStorage.getItem(KEY) as string);
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...kept, username: 'bob@example.com' }),
    );

    const next = make();
    await next.start();
    expect(next.state).toBe('off');
    // The browser's address is given up, so nothing sent to it arrives any more.
    expect(browser.state.subscribed).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('answerPushes', () => {
  const ask = (browser: ReturnType<typeof fakeBrowser>) =>
    new Promise<unknown>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        channel.port1.close();
        resolve(event.data);
      };
      browser.deliver({ type: 'mailless-state-change' }, [channel.port2]);
    });

  it('says who wrote and what about, having brought the page up to date', async () => {
    const { backend, store, browser } = await setup();
    await backend.deliver({ subject: 'Old' });
    const view = store.list({
      mailboxId: store.mailbox('inbox')?.id as string,
    });
    await store.open(view);
    const stop = answerPushes(browser.serviceWorker, store, () => false);

    const id = await backend.deliver({
      subject: 'Lunch?',
      from: 'Bob <bob@example.com>',
    });
    expect(await ask(browser)).toEqual({ title: 'Bob', body: 'Lunch?' });
    expect(view.ids[0]).toBe(id);

    await backend.deliver({ subject: 'One', from: 'Bob <bob@example.com>' });
    await backend.deliver({
      subject: 'Two',
      from: 'Carol <carol@example.com>',
    });
    expect(await ask(browser)).toEqual({
      title: '2 new messages',
      body: 'Carol, Bob',
    });

    stop();
    expect(browser.listeners.size).toBe(0);
  });

  it('says nothing is needed when someone is looking, and still shows the mail', async () => {
    const { backend, store, browser } = await setup();
    const view = store.list({
      mailboxId: store.mailbox('inbox')?.id as string,
    });
    await store.open(view);
    answerPushes(browser.serviceWorker, store, () => true);
    const id = await backend.deliver({ subject: 'Hello' });
    expect(await ask(browser)).toEqual({ quiet: true });
    expect(view.ids).toEqual([id]);
  });

  it('says only that mail arrived when it cannot tell which', async () => {
    const { backend, store, browser } = await setup();
    answerPushes(browser.serviceWorker, store, () => false);
    await backend.deliver({ subject: 'Hello' });
    // The inbox had not been looked at: everything in it is new to the page.
    expect(await ask(browser)).toEqual({ title: 'New mail', body: '' });
  });
});

describe('the service worker', () => {
  /** The worker's script, run against a stand-in for what a browser gives it. */
  function worker(tabs: Array<{ url: string; answer?: unknown }>) {
    const handlers: Record<string, (event: never) => void> = {};
    const shown: Array<{ title: string; body: string; tag: string }> = [];
    const told: unknown[] = [];
    const focused: string[] = [];
    const opened: string[] = [];
    const scope = 'https://mail.example.com/mail/';
    const sw = {
      addEventListener: (type: string, handler: (event: never) => void) => {
        handlers[type] = handler;
      },
      skipWaiting: () => undefined,
      clients: {
        claim: async () => undefined,
        matchAll: async () =>
          tabs.map((tab) => ({
            url: tab.url,
            focus: async () => focused.push(tab.url),
            postMessage: (message: { type: string }, ports?: MessagePort[]) => {
              told.push(message);
              if (tab.answer !== undefined) ports?.[0]?.postMessage(tab.answer);
            },
          })),
        openWindow: async (url: string) => opened.push(url),
      },
      registration: {
        scope,
        showNotification: async (
          title: string,
          options: { body: string; tag: string },
        ) => shown.push({ title, body: options.body, tag: options.tag }),
      },
      MessageChannel,
      setTimeout: (run: () => void) => setTimeout(run, 20),
      clearTimeout,
      URL,
    };
    const source = readFileSync(
      join(import.meta.dirname, '../../public/sw.js'),
      'utf8',
    );
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(
      'globalThis',
      'MessageChannel',
      'setTimeout',
      'clearTimeout',
      source,
    )(sw, MessageChannel, sw.setTimeout, clearTimeout);
    const fire = async (type: string, event: Record<string, unknown>) => {
      let done: Promise<unknown> = Promise.resolve();
      handlers[type]?.({
        ...event,
        waitUntil: (work: Promise<unknown>) => {
          done = work;
        },
      } as never);
      await done;
    };
    const push = (message: unknown) =>
      fire('push', { data: { json: () => message } });
    return { push, fire, shown, told, focused, opened, scope };
  }
  const change = {
    '@type': 'StateChange',
    changed: { ann: { EmailDelivery: '2' } },
  };

  it('says that mail arrived when no page is open to say more', async () => {
    const { push, shown } = worker([]);
    await push(change);
    expect(shown).toEqual([
      { title: 'New mail', body: '', tag: 'mailless-new-mail' },
    ]);
  });

  it('says who wrote and about what when the server sends that along, with no page open', async () => {
    const one = worker([]);
    await one.push({
      ...change,
      'mailless:arrived': [
        { from: 'Bob Builder', subject: 'Plans', preview: 'Shall we meet?' },
      ],
    });
    expect(one.shown).toEqual([
      {
        title: 'Bob Builder',
        body: 'Plans\nShall we meet?',
        tag: 'mailless-new-mail',
      },
    ]);

    const several = worker([]);
    await several.push({
      ...change,
      'mailless:arrived': [
        { from: 'Carol', subject: 'Invoice', preview: '' },
        { from: '', subject: '', preview: 'Hello' },
      ],
    });
    expect(several.shown).toEqual([
      {
        title: 'New messages',
        body: 'Carol: Invoice\nSomeone: (no subject)',
        tag: 'mailless-new-mail',
      },
    ]);

    // Still nothing while someone is looking at their mail.
    const looking = worker([
      { url: 'https://mail.example.com/mail/', answer: { quiet: true } },
    ]);
    await looking.push({
      ...change,
      'mailless:arrived': [{ from: 'Bob', subject: 'Plans', preview: '' }],
    });
    expect(looking.shown).toEqual([]);
  });

  it('reminds of what is about to begin in the calendar, even to someone looking at their mail', async () => {
    const soon = new Date(Date.now() + 30 * 60_000 + 5_000);
    const later = new Date(soon.getTime() + 60 * 60_000);
    const time = (date: Date) =>
      date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
    const looking = worker([
      { url: 'https://mail.example.com/mail/', answer: { quiet: true } },
    ]);
    await looking.push({
      '@type': 'StateChange',
      changed: { ann: { CalendarAlert: '0' } },
      'mailless:alerts': [
        {
          eventId: 'ev1',
          title: 'Dentist',
          utcStart: soon.toISOString(),
          utcEnd: later.toISOString(),
          showWithoutTime: false,
          location: 'Dr. Holm',
        },
        {
          eventId: 'ev2',
          title: '',
          utcStart: new Date(
            new Date().getFullYear(),
            new Date().getMonth(),
            new Date().getDate() + 1,
          ).toISOString(),
          utcEnd: '',
          showWithoutTime: true,
        },
        { eventId: 'ev3', title: 'No time at all', utcStart: 'sometime' },
      ],
    });
    expect(looking.shown).toEqual([
      {
        title: 'Dentist · in 30 min',
        body: `${time(soon)} – ${time(later)} · Dr. Holm`,
        tag: `mailless-event-ev1-${soon.toISOString()}`,
      },
      {
        title: 'An event · tomorrow',
        body: '',
        tag: expect.stringMatching(/^mailless-event-ev2-/),
      },
    ]);
    // Nobody is asked what arrived: nothing did.
    expect(looking.told).toEqual([]);
  });

  it('says what an open page tells it, and nothing when someone is looking', async () => {
    const hidden = worker([
      {
        url: 'https://mail.example.com/mail/',
        answer: { title: 'Bob', body: 'Lunch?' },
      },
    ]);
    await hidden.push(change);
    expect(hidden.shown).toEqual([
      { title: 'Bob', body: 'Lunch?', tag: 'mailless-new-mail' },
    ]);

    const looking = worker([
      {
        url: 'https://mail.example.com/mail/',
        answer: { title: 'Bob', body: 'x' },
      },
      { url: 'https://mail.example.com/mail/box/1', answer: { quiet: true } },
    ]);
    await looking.push(change);
    expect(looking.shown).toEqual([]);
  });

  it('does not wait for ever for a page that does not answer', async () => {
    const { push, shown } = worker([{ url: 'https://mail.example.com/mail/' }]);
    await push(change);
    expect(shown).toHaveLength(1);
  });

  it('hands the server’s test push to the page, and shows nothing for it', async () => {
    const { push, shown, told } = worker([
      { url: 'https://mail.example.com/mail/' },
    ]);
    await push({
      '@type': 'PushVerification',
      pushSubscriptionId: 'p1',
      verificationCode: 'secret',
    });
    expect(shown).toEqual([]);
    expect(told).toEqual([
      {
        type: 'mailless-push-verification',
        pushSubscriptionId: 'p1',
        verificationCode: 'secret',
      },
    ]);
  });

  it('opens the mail when the notification is pressed', async () => {
    const close = vi.fn();
    const open = worker([{ url: 'https://mail.example.com/mail/box/1' }]);
    await open.fire('notificationclick', { notification: { close } });
    expect(close).toHaveBeenCalled();
    expect(open.focused).toEqual(['https://mail.example.com/mail/box/1']);

    const closed = worker([{ url: 'https://mail.example.com/admin/' }]);
    await closed.fire('notificationclick', { notification: { close } });
    expect(closed.opened).toEqual([closed.scope]);
  });
});
