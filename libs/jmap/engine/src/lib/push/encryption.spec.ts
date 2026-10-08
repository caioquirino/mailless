import {
  decodeBase64Url,
  encryptPush,
  isUsablePushKeys,
  MAX_PUSH_PLAINTEXT,
} from './encryption.js';

// The worked example of RFC 8291, section 5 and appendix A.
const RECEIVER = {
  p256dh:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const SENDER_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const SENDER_PUBLIC =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const EXPECTED =
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
  'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
  'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

const bytes = (text: string) => decodeBase64Url(text) as Uint8Array;
const base64Url = (data: Uint8Array) => Buffer.from(data).toString('base64url');

async function senderKeys() {
  const point = bytes(SENDER_PUBLIC);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64Url(point.subarray(1, 33)),
    y: base64Url(point.subarray(33)),
  };
  const curve = { name: 'ECDH', namedCurve: 'P-256' };
  return {
    publicKey: await crypto.subtle.importKey('jwk', jwk, curve, true, []),
    privateKey: await crypto.subtle.importKey(
      'jwk',
      { ...jwk, d: SENDER_PRIVATE },
      curve,
      true,
      ['deriveBits'],
    ),
  };
}

describe('Web Push encryption', () => {
  it('reproduces the example of RFC 8291', async () => {
    const encrypted = await encryptPush(
      new TextEncoder().encode('When I grow up, I want to be a watermelon'),
      RECEIVER,
      { salt: bytes(SALT), senderKeys: await senderKeys() },
    );
    expect(base64Url(encrypted)).toBe(EXPECTED);
  });

  it('uses a new salt and key pair for every message', async () => {
    const message = new TextEncoder().encode('same message');
    const first = await encryptPush(message, RECEIVER);
    const second = await encryptPush(message, RECEIVER);
    expect(first).toHaveLength(second.length);
    expect(base64Url(first.subarray(0, 16))).not.toBe(
      base64Url(second.subarray(0, 16)),
    );
    expect(base64Url(first.subarray(21, 86))).not.toBe(
      base64Url(second.subarray(21, 86)),
    );
  });

  it('keeps the whole body within what push services accept', async () => {
    const largest = await encryptPush(
      new Uint8Array(MAX_PUSH_PLAINTEXT),
      RECEIVER,
    );
    expect(largest).toHaveLength(4096);
    await expect(
      encryptPush(new Uint8Array(MAX_PUSH_PLAINTEXT + 1), RECEIVER),
    ).rejects.toThrow(/at most/);
  });

  it('accepts only keys it can encrypt to', async () => {
    expect(await isUsablePushKeys(RECEIVER)).toBe(true);
    // Padded base64 is the same key.
    expect(
      await isUsablePushKeys({ ...RECEIVER, auth: `${RECEIVER.auth}==` }),
    ).toBe(true);

    const offCurve = bytes(RECEIVER.p256dh).slice();
    offCurve[64] = (offCurve[64] as number) ^ 1;
    for (const keys of [
      { ...RECEIVER, auth: 'c2hvcnQ' },
      { ...RECEIVER, auth: 'not base64!' },
      { ...RECEIVER, p256dh: RECEIVER.p256dh.slice(0, 40) },
      { ...RECEIVER, p256dh: base64Url(offCurve) },
      { ...RECEIVER, p256dh: base64Url(new Uint8Array(65)) },
    ]) {
      expect(await isUsablePushKeys(keys), JSON.stringify(keys)).toBe(false);
    }
    await expect(
      encryptPush(new Uint8Array(1), { ...RECEIVER, auth: 'c2hvcnQ' }),
    ).rejects.toThrow(/not usable/);
  });
});
