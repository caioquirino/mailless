import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/*
 * Fetching a calendar someone keeps elsewhere, from the address they copied
 * in. The address is whatever the account's owner typed: it is fetched only
 * when it is a public place on the web, so that this server cannot be sent
 * to look at what only it can reach. The address is a secret of its owner's
 * and is never written to a log, nor into what is said when it fails.
 */

const MAX_OCTETS = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MILLIS = 10_000;

/** Whether an address is one of a network of its own, of this machine, or of nothing. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff') ||
      lower.startsWith('::ffff:')
    );
  }
  return true;
}

export interface CalendarFetchDependencies {
  fetch: typeof fetch;
  /** Every address a name leads to. */
  resolve(host: string): Promise<string[]>;
}

const real: CalendarFetchDependencies = {
  fetch: (...args) => fetch(...args),
  resolve: async (host) =>
    (await lookup(host, { all: true })).map((found) => found.address),
};

async function checked(
  given: string,
  deps: CalendarFetchDependencies,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error('That is not an address');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    isIP(host) !== 0 ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(host)
  ) {
    throw new Error('Only a public https address can be fetched');
  }
  let addresses: string[];
  try {
    addresses = await deps.resolve(host);
  } catch {
    throw new Error('That address could not be found');
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('Only a public https address can be fetched');
  }
  return url;
}

/** The text of the calendar published at an address. */
export async function fetchCalendar(
  given: string,
  deps: CalendarFetchDependencies = real,
): Promise<string> {
  let url = await checked(given, deps);
  for (let hops = 0; ; hops++) {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        redirect: 'manual',
        headers: { accept: 'text/calendar, text/plain;q=0.5' },
        signal: AbortSignal.timeout(TIMEOUT_MILLIS),
      });
    } catch {
      throw new Error('The calendar did not answer');
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next || hops >= MAX_REDIRECTS) {
        throw new Error('The address leads nowhere');
      }
      // Wherever it is sent on to is held to the same.
      url = await checked(new URL(next, url).href, deps);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        response.status === 404 || response.status === 410
          ? 'Nothing is published at that address any more'
          : response.status === 401 || response.status === 403
            ? 'The address does not let the calendar be read'
            : `The calendar answered with an error (${response.status})`,
      );
    }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_OCTETS) {
      throw new Error('The calendar is too large');
    }
    const pieces: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_OCTETS) {
        await reader.cancel();
        throw new Error('The calendar is too large');
      }
      pieces.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) {
      all.set(piece, at);
      at += piece.length;
    }
    return new TextDecoder().decode(all);
  }
}
