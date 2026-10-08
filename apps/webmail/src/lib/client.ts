import { createJmapClient, type JmapClient } from '@mailless/jmap-client';
import type { Session } from '@mailless/web-session';

export interface MailClientOptions {
  sessionUrl: string;
  session: Session;
  fetch?: typeof fetch;
  /**
   * Sends every request to the site the page came from, whatever address the
   * server gives for itself. For running the page on one's own machine in
   * front of a real server, where the browser must see one origin.
   */
  sameOrigin?: string;
}

/**
 * The mail server, as whoever is signed in. A request that is refused
 * because the token ran out is tried once more with a fresh one; if that is
 * refused too, the user is signed out here.
 */
export function createMailClient(options: MailClientOptions): JmapClient {
  const { session } = options;
  const fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));

  const send = (input: RequestInfo | URL, init?: RequestInit) => {
    let url = input instanceof Request ? input.url : String(input);
    if (options.sameOrigin) {
      const target = new URL(url, options.sameOrigin);
      url = new URL(`${target.pathname}${target.search}`, options.sameOrigin)
        .href;
    }
    const headers = new Headers(init?.headers);
    const token = session.accessToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    else headers.delete('authorization');
    return fetcher(url, { ...init, headers });
  };

  return createJmapClient({
    sessionUrl: options.sessionUrl,
    // Set on every request by what follows, with the token of the moment.
    authorization: '',
    fetch: async (input, init) => {
      let response = await send(input, init);
      if (response.status === 401) {
        if (await session.renew()) response = await send(input, init);
        if (response.status === 401) session.forget();
      }
      return response;
    },
  });
}
