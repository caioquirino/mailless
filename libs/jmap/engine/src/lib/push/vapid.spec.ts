import { decodeBase64Url } from './encryption.js';
import { createVapid, generateVapidKeys } from './vapid.js';

const SUBJECT = 'mailto:postmaster@example.com';

function parse(header: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (!match) throw new Error(`Not a vapid header: ${header}`);
  const [head, claims, signature] = (match[1] as string).split('.') as [
    string,
    string,
    string,
  ];
  const json = (part: string) =>
    JSON.parse(
      new TextDecoder().decode(
        decodeBase64Url(part) as Uint8Array<ArrayBuffer>,
      ),
    ) as Record<string, unknown>;
  return {
    token: match[1] as string,
    key: match[2] as string,
    head: json(head),
    claims: json(claims),
    signed: `${head}.${claims}`,
    signature: decodeBase64Url(signature) as Uint8Array<ArrayBuffer>,
  };
}

describe('VAPID', () => {
  it('makes a key pair in the form a push service and a browser expect', async () => {
    const keys = await generateVapidKeys();
    const point = decodeBase64Url(keys.publicKey);
    expect(point).toHaveLength(65);
    expect(point?.[0]).toBe(4);
    expect(decodeBase64Url(keys.privateKey)).toHaveLength(32);
    expect(keys.publicKey + keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await generateVapidKeys()).publicKey).not.toBe(keys.publicKey);
  });

  it('signs a token for the push service a push goes to, which the public key verifies', async () => {
    const keys = await generateVapidKeys();
    const now = new Date('2026-10-08T12:00:00Z');
    const vapid = createVapid({ ...keys, subject: SUBJECT }, () => now);
    const header = parse(
      await vapid.authorization(
        'https://fcm.googleapis.com/fcm/send/abc:def?x=1',
      ),
    );

    expect(header.key).toBe(keys.publicKey);
    expect(header.head).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(header.claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now.getTime() / 1000 + 12 * 60 * 60,
      sub: SUBJECT,
    });
    const publicKey = await crypto.subtle.importKey(
      'raw',
      decodeBase64Url(keys.publicKey) as Uint8Array<ArrayBuffer>,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(header.signature).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        header.signature,
        new TextEncoder().encode(header.signed),
      ),
    ).toBe(true);
  });

  it('uses one token per push service until it is close to expiring', async () => {
    const keys = await generateVapidKeys();
    let now = new Date('2026-10-08T12:00:00Z');
    const vapid = createVapid({ ...keys, subject: SUBJECT }, () => now);
    const first = await vapid.authorization('https://push.example.net/a');
    expect(await vapid.authorization('https://push.example.net/b')).toBe(first);
    expect(
      parse(await vapid.authorization('https://other.example.org/a')).claims[
        'aud'
      ],
    ).toBe('https://other.example.org');

    now = new Date('2026-10-08T22:59:00Z');
    expect(await vapid.authorization('https://push.example.net/a')).toBe(first);
    now = new Date('2026-10-08T23:01:00Z');
    const renewed = await vapid.authorization('https://push.example.net/a');
    expect(renewed).not.toBe(first);
    expect(parse(renewed).claims['exp']).toBe(now.getTime() / 1000 + 43200);
  });

  it('refuses keys and subjects that are not what they should be', async () => {
    const keys = await generateVapidKeys();
    expect(() => createVapid({ ...keys, subject: 'someone' })).toThrow(
      /subject/,
    );
    expect(() =>
      createVapid({ ...keys, publicKey: keys.privateKey, subject: SUBJECT }),
    ).toThrow(/P-256/);
    expect(() =>
      createVapid({ ...keys, privateKey: 'short', subject: SUBJECT }),
    ).toThrow(/P-256/);
    expect(() =>
      createVapid({ ...keys, subject: 'https://example.com/contact' }),
    ).not.toThrow();
  });
});
