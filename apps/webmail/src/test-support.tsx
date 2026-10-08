import { createJmapClient } from '@mailless/jmap-client';
import { createJmapServer, generateVapidKeys } from '@mailless/jmap-server';
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';
import {
  buildMessage,
  decryptPush,
  PUSH_RECEIVER_KEYS,
} from '@mailless/jmap-server/testing';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Session } from '@mailless/web-session';
import { App } from './app/app';
import { ServicesProvider, type Services } from './app/services';
import { createMailClient } from './lib/client';
import type { AppConfig } from './lib/config';
import { MailStore } from './lib/mail';

export const ORIGIN = 'https://mail.example.com';
const AUTH = { accountId: 'ann', username: 'ann@example.com' };

export const CONFIG: AppConfig = {
  sessionUrl: `${ORIGIN}/.well-known/jmap`,
  clientId: 'webmail-client',
  authorizeUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  logoutUrl: 'https://auth.example.com/logout',
  scopes: ['openid'],
  accountUrl: '/admin/',
};

type MessageOptions = NonNullable<Parameters<typeof buildMessage>[0]>;

/**
 * A real mail server over memory, reached through its HTTP handler without
 * a network, and an identity provider that gives out tokens it accepts.
 */
export async function fakeBackend() {
  const sent: Array<{ message: string; recipients: string[] }> = [];
  const storage = new InMemoryStorageAdapter();
  /** Pushes, as a push service gets them. Unread until a test says where they go. */
  const push = {
    onPush: undefined as
      ((url: string, message: Record<string, unknown>) => void) | undefined,
    known: new Map<string, string>(),
    /** Tells subscriptions what changed since the last time, as the host of a server does. */
    flush: async () => {
      const changed: string[] = [];
      for (const type of ['Email', 'EmailDelivery', 'Mailbox', 'Thread']) {
        const state = await storage.metadata.getState(AUTH.accountId, type);
        if (push.known.get(type) !== state) changed.push(type);
        push.known.set(type, state);
      }
      if (changed.length > 0) {
        await server.pushStateChange(AUTH.accountId, changed);
      }
    },
  };
  const server = createJmapServer({
    storage,
    push: {
      vapid: {
        ...(await generateVapidKeys()),
        subject: 'mailto:postmaster@example.com',
      },
      // The push service of these tests is not somewhere a real server would write to.
      allowUrl: () => true,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        push.onPush?.(
          request.url,
          decryptPush(new Uint8Array(await request.arrayBuffer())) as Record<
            string,
            unknown
          >,
        );
        return new Response(null, { status: 201 });
      },
    },
    urls: jmapUrls(ORIGIN),
    transport: {
      send: async (message, envelope) => {
        sent.push({
          message: new TextDecoder().decode(message),
          recipients: [...envelope.rcptTo],
        });
      },
    },
    identities: () => [{ id: 'ann', email: 'ann@example.com', name: 'Ann' }],
  });
  await server.provisionAccount(AUTH);

  const state = {
    /** The tokens the server accepts. */
    accepted: new Set<string>(),
    tokenRequests: [] as Array<Record<string, string>>,
    /** How many requests reached the mail server's API. */
    posts: 0,
    issued: 0,
  };
  const handler = createFetchHandler({
    server,
    authenticate: async (request) => {
      const token = /^Bearer (.+)$/.exec(
        request.headers.get('authorization') ?? '',
      )?.[1];
      return token && state.accepted.has(token) ? AUTH : null;
    },
  });

  const fetcher = (async (input, init) => {
    const request = new Request(input, init);
    if (request.url === CONFIG.tokenUrl) {
      state.tokenRequests.push(
        Object.fromEntries(new URLSearchParams(await request.text())),
      );
      const token = `token-${++state.issued}`;
      state.accepted.add(token);
      return Response.json({
        access_token: token,
        refresh_token: 'refresh-1',
        expires_in: 3600,
      });
    }
    if (request.method === 'POST' && request.url.endsWith('/jmap/api')) {
      state.posts++;
    }
    return handler(request);
  }) as typeof fetch;

  let sequence = 0;
  /** Puts a message in a mailbox, as delivery does. Each is a minute newer than the last. */
  const deliver = async (
    options: MessageOptions & { mailbox?: string; seen?: boolean } = {},
  ) => {
    sequence++;
    const when = new Date(Date.UTC(2026, 0, 5, 9, sequence));
    const { mailbox, seen, ...message } = options;
    const imported = await server.importMessage(
      AUTH,
      new TextEncoder().encode(
        buildMessage({
          messageId: `<m${sequence}@example.com>`,
          date: when.toUTCString(),
          ...message,
        }),
      ),
      {
        mailboxRole: mailbox ?? 'inbox',
        // As mail from outside, which is what moves the state clients watch for new mail.
        delivery: true,
        receivedAt: when.toISOString().replace('.000', ''),
        ...(seen ? { keywords: { $seen: true } } : {}),
      },
    );
    return imported.id;
  };

  // What is there to begin with is not news.
  await push.flush();
  return { server, state, sent, push, fetch: fetcher, deliver };
}

export type FakeBackend = Awaited<ReturnType<typeof fakeBackend>>;

/** A store wired straight to the backend, as someone signed in. */
export async function testStore(backend: FakeBackend) {
  backend.state.accepted.add('direct');
  const client = createJmapClient({
    sessionUrl: CONFIG.sessionUrl,
    authorization: 'Bearer direct',
    fetch: backend.fetch,
  });
  const store = new MailStore(client);
  await store.start();
  return store;
}

/** A session wired to the fake backend, with what it would have done to the browser recorded. */
export function testSession(backend: FakeBackend) {
  const visited: string[] = [];
  const session = new Session(CONFIG, {
    fetch: backend.fetch,
    storage: window.sessionStorage,
    navigate: (url) => visited.push(url),
    now: () => Date.now(),
    baseUrl: `${ORIGIN}/mail/`,
    storageKey: 'mailless.mail',
  });
  return { session, visited };
}

/** Signs in the way a person does: to the provider and back with a code. */
export async function signIn(
  session: Session,
  visited: string[],
): Promise<void> {
  await session.beginSignIn();
  const state = new URL(visited.at(-1) as string).searchParams.get('state');
  await session.completeSignIn(
    new URLSearchParams({ code: 'code-1', state: state as string }),
  );
}

/** The whole page at a path, against the fake backend. Signed in unless told otherwise. */
export async function renderApp(
  backend: FakeBackend,
  path = '/',
  options: {
    signedIn?: boolean;
    push?: Services['push'];
    theme?: Services['theme'];
  } = {},
): Promise<RenderResult & { session: Session; visited: string[] }> {
  const { session, visited } = testSession(backend);
  await session.restore();
  if (options.signedIn ?? true) await signIn(session, visited);
  const client = createMailClient({
    sessionUrl: CONFIG.sessionUrl,
    session,
    fetch: backend.fetch,
  });
  const view = render(
    <ServicesProvider
      value={{
        config: CONFIG,
        session,
        client,
        ...(options.push ? { push: options.push } : {}),
        ...(options.theme ? { theme: options.theme } : {}),
      }}
    >
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ServicesProvider>,
  );
  return { ...view, session, visited };
}

export const PUSH_ENDPOINT = 'https://push.example.com/send/abc';
const ENDPOINT = PUSH_ENDPOINT;

/** A browser as far as notifications go, and the push service between the server and it. */
export function fakeBrowser(
  backend: FakeBackend,
  options: { verify?: boolean } = {},
) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const state = {
    permission: 'default' as NotificationPermission,
    answer: 'granted' as NotificationPermission,
    asked: 0,
    subscribed: false,
    registered: [] as string[],
    subscribedWith: undefined as PushSubscriptionOptionsInit | undefined,
  };
  const subscription = {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: PUSH_RECEIVER_KEYS }),
    unsubscribe: async () => {
      state.subscribed = false;
      return true;
    },
  } as unknown as PushSubscription;
  const registration = {
    pushManager: {
      subscribe: async (init: PushSubscriptionOptionsInit) => {
        state.subscribed = true;
        state.subscribedWith = init;
        return subscription;
      },
      getSubscription: async () => (state.subscribed ? subscription : null),
    },
  } as unknown as ServiceWorkerRegistration;
  const serviceWorker = {
    register: async (url: string) => {
      state.registered.push(url);
      return registration;
    },
    ready: Promise.resolve(registration),
    getRegistration: async () =>
      state.registered.length > 0 ? registration : undefined,
    addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
  } as unknown as ServiceWorkerContainer;
  const deliver = (data: unknown, ports: MessagePort[] = []) => {
    for (const listener of [...listeners]) {
      listener({ data, ports } as unknown as MessageEvent);
    }
  };

  // The push service: what the server posts to the browser's address reaches the worker, which tells the page.
  const pushes: Array<Record<string, unknown>> = [];
  backend.push.onPush = (url, message) => {
    if (url !== ENDPOINT) return;
    pushes.push(message);
    if (message['@type'] === 'PushVerification' && options.verify !== false) {
      deliver({
        type: 'mailless-push-verification',
        pushSubscriptionId: message['pushSubscriptionId'],
        verificationCode: message['verificationCode'],
      });
    }
  };

  return {
    state,
    pushes,
    deliver,
    listeners,
    serviceWorker,
    deps: {
      storage: window.localStorage,
      serviceWorker,
      workerUrl: 'https://mail.example.com/mail/sw.js',
      scope: '/mail/',
      permission: () => state.permission,
      requestPermission: async () => {
        state.asked++;
        state.permission = state.answer;
        return state.answer;
      },
      now: () => Date.now(),
      verifyMs: 50,
    },
  };
}
