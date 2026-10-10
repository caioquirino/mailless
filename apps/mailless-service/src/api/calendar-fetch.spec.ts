import { fetchCalendar, isPrivateAddress } from './calendar-fetch.js';

const FEED = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';

function deps(
  pages: Record<string, Response | (() => Response)>,
  names: Record<string, string[]> = {},
) {
  const asked: string[] = [];
  return {
    asked,
    fetch: (async (input: unknown) => {
      const url = String(input);
      asked.push(url);
      const page = pages[url];
      if (!page) throw new Error('unreachable');
      return typeof page === 'function' ? page() : page;
    }) as typeof fetch,
    resolve: async (host: string) => names[host] ?? ['93.184.216.34'],
  };
}

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    'not an address',
  ])('%s is not public', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:2800:220:1::1'])(
    '%s is public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('fetchCalendar', () => {
  it('gives what is published at a public address, following where it is sent on', async () => {
    const d = deps({
      'https://calendar.example/a.ics': new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.calendar.example/b.ics' },
      }),
      'https://cdn.calendar.example/b.ics': new Response(FEED),
    });
    expect(await fetchCalendar('https://calendar.example/a.ics', d)).toBe(FEED);
    expect(d.asked).toHaveLength(2);
  });

  it.each([
    'http://calendar.example/a.ics',
    'https://127.0.0.1/a.ics',
    'https://[::1]/a.ics',
    'https://localhost/a.ics',
    'https://calendar.example:8443/a.ics',
    'https://user:secret@calendar.example/a.ics',
    'https://metadata.internal/a.ics',
    'file:///etc/passwd',
    'nonsense',
  ])('does not go to %s', async (url) => {
    const d = deps({});
    await expect(fetchCalendar(url, d)).rejects.toThrow();
    expect(d.asked).toEqual([]);
  });

  it('does not go where a public name leads to a private place, at first or sent on', async () => {
    const inside = deps({}, { 'calendar.example': ['10.0.0.5'] });
    await expect(
      fetchCalendar('https://calendar.example/a.ics', inside),
    ).rejects.toThrow(/public/);
    expect(inside.asked).toEqual([]);

    const sentOn = deps(
      {
        'https://calendar.example/a.ics': new Response(null, {
          status: 301,
          headers: { location: 'https://inner.example/x' },
        }),
      },
      { 'inner.example': ['93.184.216.34', '169.254.169.254'] },
    );
    await expect(
      fetchCalendar('https://calendar.example/a.ics', sentOn),
    ).rejects.toThrow(/public/);
    expect(sentOn.asked).toEqual(['https://calendar.example/a.ics']);
  });

  it('says why it failed, without saying the address', async () => {
    const url = 'https://calendar.example/private-secret-token/basic.ics';
    for (const [status, said] of [
      [404, /any more/],
      [403, /does not let/],
      [500, /error \(500\)/],
    ] as const) {
      const failure = await fetchCalendar(
        url,
        deps({ [url]: new Response('no', { status }) }),
      ).catch((error: Error) => error);
      expect((failure as Error).message).toMatch(said);
      expect((failure as Error).message).not.toContain('secret');
    }
    const loop = () =>
      new Response(null, { status: 302, headers: { location: url } });
    await expect(fetchCalendar(url, deps({ [url]: loop }))).rejects.toThrow(
      /leads nowhere/,
    );
    await expect(
      fetchCalendar(
        url,
        deps({
          [url]: new Response('x', {
            headers: { 'content-length': String(50 * 1024 * 1024) },
          }),
        }),
      ),
    ).rejects.toThrow(/too large/);
  });
});
