import type { JmapClient } from '@mailless/jmap-client';
import type { Email, Id } from '@mailless/jmap-core';
import { nameOf } from './addresses';
import { MailError, type MailStore } from './mail';

/*
 * Telling the person that mail arrived, whether or not the page is open.
 *
 * The browser gives the page an address at its push service; the page hands
 * that address to the mail server (a push subscription, RFC 8620 §7.2),
 * which writes to it when mail is delivered. The browser wakes the page's
 * service worker, which shows the notification. No connection is held open
 * by anyone, and nothing runs on the server between two messages.
 */

/** The capability under which a server says which key it signs pushes with (RFC 9749). */
const CAPABILITY_VAPID = 'urn:ietf:params:jmap:webpush-vapid';

/** A subscription this close to running out is given more time. */
const RENEW_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

/** How long the server's test push may take to come round. */
const VERIFY_MS = 30_000;

/**
 * - `unsupported`: this browser or this server cannot do it;
 * - `blocked`: the person told the browser not to let this site notify;
 * - `off` and `on`: as chosen here.
 */
export type NotificationState = 'unsupported' | 'blocked' | 'off' | 'on';

/** What is remembered in the browser about the subscription made from it. */
interface Kept {
  id: Id;
  deviceClientId: string;
  endpoint: string;
  /** Whose mail it is for: someone else signing in here must not get it. */
  username: string;
}

export interface NotificationsDependencies {
  client: JmapClient;
  /** Outlives the tab: notifications go on after it is closed. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The browser's service workers, when it has them. */
  serviceWorker: ServiceWorkerContainer | undefined;
  /** Where the worker's script is, and the part of the site it is for. */
  workerUrl: string;
  scope: string;
  /** What the person has told the browser, or undefined when it cannot notify. */
  permission(): NotificationPermission | undefined;
  /** Asks the person. Only ever called because they pressed something. */
  requestPermission(): Promise<NotificationPermission>;
  now(): number;
  /** How long to wait for the server's test push. */
  verifyMs?: number;
}

const KEY = 'mailless.mail.push';

function bytesOf(base64Url: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64Url.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface Verification {
  pushSubscriptionId: string;
  verificationCode: string;
}

export class Notifications {
  private current: NotificationState = 'off';
  private readonly listeners = new Set<() => void>();
  private working: Promise<void> | undefined;

  constructor(private readonly deps: NotificationsDependencies) {
    if (!deps.serviceWorker || deps.permission() === undefined) {
      this.current = 'unsupported';
    }
  }

  get state(): NotificationState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(state: NotificationState): void {
    if (state === this.current) return;
    this.current = state;
    for (const listener of [...this.listeners]) listener();
  }

  private kept(): Kept | null {
    try {
      const value = JSON.parse(
        this.deps.storage.getItem(KEY) ?? 'null',
      ) as Partial<Kept> | null;
      return value &&
        typeof value.id === 'string' &&
        typeof value.deviceClientId === 'string' &&
        typeof value.endpoint === 'string' &&
        typeof value.username === 'string'
        ? (value as Kept)
        : null;
    } catch {
      return null;
    }
  }

  /** One thing at a time: turning on and off do not run over each other. */
  private exclusively(work: () => Promise<void>): Promise<void> {
    const next = (this.working ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.working = next;
    return next;
  }

  private async serverKey(): Promise<string | null> {
    const capability = (await this.deps.client.session()).capabilities[
      CAPABILITY_VAPID
    ] as { applicationServerKey?: unknown } | undefined;
    const key = capability?.applicationServerKey;
    return typeof key === 'string' && key !== '' ? key : null;
  }

  private async registration(): Promise<ServiceWorkerRegistration> {
    const container = this.deps.serviceWorker as ServiceWorkerContainer;
    const registration = await container.register(this.deps.workerUrl, {
      scope: this.deps.scope,
    });
    await container.ready;
    return registration;
  }

  /** The browser's own end of it, when there is one already. */
  private async browserSubscription(): Promise<PushSubscription | null> {
    const registration = await this.deps.serviceWorker?.getRegistration(
      this.deps.scope,
    );
    return (await registration?.pushManager?.getSubscription()) ?? null;
  }

  /**
   * Picks up what was chosen before, on this browser: checks that the
   * subscription is still there at both ends, gives it more time when it is
   * running out, and makes it again when it has gone. To be called once
   * someone is signed in.
   */
  start(): Promise<void> {
    return this.exclusively(async () => {
      if (this.current === 'unsupported') return;
      if ((await this.serverKey()) === null) return this.set('unsupported');
      const permission = this.deps.permission();
      if (permission === 'denied') return this.set('blocked');

      const kept = this.kept();
      if (!kept) return this.set('off');
      const { username } = await this.deps.client.session();
      const browser = await this.browserSubscription();
      if (kept.username !== username) {
        // Left by someone else who used this browser. Their mail is not to be
        // announced here: without the address the browser gave, the server
        // cannot reach it, and lets go of its end the next time it tries.
        await browser?.unsubscribe().catch(() => undefined);
        this.deps.storage.removeItem(KEY);
        return this.set('off');
      }
      if (permission !== 'granted') {
        this.deps.storage.removeItem(KEY);
        return this.set('off');
      }

      const found = (await this.deps.client.call('PushSubscription/get', {
        ids: [kept.id],
        properties: ['expires', 'verificationCode'],
      })) as { list?: Array<{ expires?: string | null }> };
      const held = found.list?.[0];
      if (!held || !browser || browser.endpoint !== kept.endpoint) {
        // Gone at one end or the other; the person asked for it, so make it again.
        await this.forget(kept);
        await this.make();
        return;
      }
      const expires = held.expires ? Date.parse(held.expires) : NaN;
      if (!(expires - this.deps.now() > RENEW_WITHIN_MS)) {
        // As long again as the server gives.
        await this.deps.client.call('PushSubscription/set', {
          update: { [kept.id]: { expires: null } },
        });
      }
      this.set('on');
    });
  }

  /** Turns notifications on. Asks the person first, so call it because they pressed something. */
  enable(): Promise<void> {
    return this.exclusively(async () => {
      if (this.current === 'unsupported') {
        throw new MailError('This browser cannot show notifications.');
      }
      const permission =
        this.deps.permission() === 'granted'
          ? 'granted'
          : await this.deps.requestPermission();
      if (permission !== 'granted') {
        this.set(permission === 'denied' ? 'blocked' : 'off');
        throw new MailError(
          permission === 'denied'
            ? 'Notifications are blocked for this site. Allow them in the browser’s settings for it, then try again.'
            : 'Notifications were not allowed.',
        );
      }
      const kept = this.kept();
      if (kept) await this.forget(kept);
      await this.make();
    });
  }

  /** Makes the subscription at both ends, and proves to the server that pushes arrive. */
  private async make(): Promise<void> {
    const { client } = this.deps;
    const key = await this.serverKey();
    if (key === null) {
      this.set('unsupported');
      throw new MailError('The mail server does not send notifications.');
    }
    const container = this.deps.serviceWorker as ServiceWorkerContainer;
    const registration = await this.registration();

    // The server's test push may come round before its answer does: listen first.
    const heard: Verification[] = [];
    let tell: (() => void) | undefined;
    const listen = (event: MessageEvent) => {
      const data = event.data as Partial<Verification> & { type?: string };
      if (
        data?.type !== 'mailless-push-verification' ||
        typeof data.pushSubscriptionId !== 'string' ||
        typeof data.verificationCode !== 'string'
      ) {
        return;
      }
      heard.push(data as Verification);
      tell?.();
    };
    container.addEventListener('message', listen);

    let browser: PushSubscription | undefined;
    let id: Id | undefined;
    try {
      browser = await registration.pushManager.subscribe({
        // A notification is shown for every push, as browsers require.
        userVisibleOnly: true,
        applicationServerKey: bytesOf(key),
      });
      const keys = browser.toJSON().keys ?? {};
      const deviceClientId = crypto.randomUUID();
      const made = (await client.call('PushSubscription/set', {
        create: {
          new: {
            deviceClientId,
            url: browser.endpoint,
            keys: { p256dh: keys['p256dh'], auth: keys['auth'] },
            // Only when mail is delivered: that is what there is to announce.
            types: ['EmailDelivery'],
          },
        },
      })) as {
        created?: Record<string, { id?: Id }> | null;
      };
      id = made.created?.['new']?.id;
      if (!id) {
        throw new MailError(
          'The mail server did not accept this browser for notifications.',
        );
      }

      const wanted = id;
      const verification = await new Promise<Verification | undefined>(
        (resolve) => {
          const find = () =>
            heard.find((each) => each.pushSubscriptionId === wanted);
          const timer = setTimeout(
            () => resolve(find()),
            this.deps.verifyMs ?? VERIFY_MS,
          );
          tell = () => {
            const found = find();
            if (!found) return;
            clearTimeout(timer);
            resolve(found);
          };
          tell();
        },
      );
      if (!verification) {
        throw new MailError(
          'The test notification did not arrive, so notifications stay off. Try again in a moment.',
        );
      }
      const confirmed = (await client.call('PushSubscription/set', {
        update: { [id]: { verificationCode: verification.verificationCode } },
      })) as { notUpdated?: Record<string, unknown> | null };
      if (confirmed.notUpdated?.[id]) {
        throw new MailError('The mail server did not confirm notifications.');
      }
      const { username } = await client.session();
      this.deps.storage.setItem(
        KEY,
        JSON.stringify({
          id,
          deviceClientId,
          endpoint: browser.endpoint,
          username,
        } satisfies Kept),
      );
      this.set('on');
    } catch (error) {
      // Half made is not made: neither end is left behind.
      if (id) {
        await client
          .call('PushSubscription/set', { destroy: [id] })
          .catch(() => undefined);
      }
      await browser?.unsubscribe().catch(() => undefined);
      this.deps.storage.removeItem(KEY);
      this.set('off');
      throw error instanceof MailError
        ? error
        : new MailError('Notifications could not be turned on. Try again.');
    } finally {
      container.removeEventListener('message', listen);
    }
  }

  /** Lets go of the subscription at both ends. Each end is tried whatever becomes of the other. */
  private async forget(kept: Kept): Promise<void> {
    await this.deps.client
      .call('PushSubscription/set', { destroy: [kept.id] })
      .catch(() => undefined);
    const browser = await this.browserSubscription().catch(() => null);
    await browser?.unsubscribe().catch(() => undefined);
    this.deps.storage.removeItem(KEY);
  }

  /** Turns notifications off. Also what signing out does: mail is not announced to a browser nobody is signed in to. */
  disable(): Promise<void> {
    return this.exclusively(async () => {
      if (this.current === 'unsupported') return;
      const kept = this.kept();
      if (kept) await this.forget(kept);
      this.set(this.deps.permission() === 'denied' ? 'blocked' : 'off');
    });
  }
}

/** What a notification says. `quiet` when there is nothing to say: someone is looking. */
export type Announcement = { quiet: true } | { title: string; body: string };

function announce(emails: readonly Email[]): Announcement {
  const [only] = emails;
  if (emails.length === 0 || !only) return { title: 'New mail', body: '' };
  const sender = (email: Email) => {
    const from = email.from?.[0];
    return from ? nameOf(from) : 'Someone';
  };
  if (emails.length === 1) {
    return { title: sender(only), body: only.subject || '(no subject)' };
  }
  return {
    title: `${emails.length} new messages`,
    body: [...new Set(emails.map(sender))].slice(0, 4).join(', '),
  };
}

/**
 * Answers the service worker when it hears that mail arrived: brings the
 * page up to date, and says what a notification should tell, or that none is
 * needed because someone is looking at the page. Returns how to stop.
 */
export function answerPushes(
  serviceWorker: ServiceWorkerContainer | undefined,
  store: MailStore,
  isLooking: () => boolean,
): () => void {
  if (!serviceWorker) return () => undefined;
  const listen = (event: MessageEvent) => {
    if ((event.data as { type?: string })?.type !== 'mailless-state-change') {
      return;
    }
    const port = event.ports[0];
    void (async (): Promise<Announcement> => {
      const inbox = store.mailbox('inbox');
      if (!inbox) {
        await store.refresh();
        return announce([]);
      }
      const view = store.list({ mailboxId: inbox.id });
      const known = view.isLoaded ? new Set(view.ids) : null;
      if (!known) await store.open(view);
      // Everything else follows too: what is unread, and where.
      await store.refresh();
      if (isLooking()) return { quiet: true };
      // What is at the top of the inbox now and was not before, and has not been read elsewhere since.
      const arrived = known
        ? view.ids
            .filter((id) => !known.has(id))
            .map((id) => store.emails.get(id))
            .filter(
              (email): email is Email =>
                email !== undefined && !email.keywords['$seen'],
            )
        : [];
      return announce(arrived);
    })()
      .catch((): Announcement | null => null)
      // No answer at all leaves the worker to say what it can by itself.
      .then((answer) => port?.postMessage(answer));
  };
  serviceWorker.addEventListener('message', listen);
  return () => serviceWorker.removeEventListener('message', listen);
}
