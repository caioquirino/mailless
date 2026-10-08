/*
 * Message encryption for Web Push (RFC 8291), using the aes128gcm content
 * coding (RFC 8188). A client that gives keys with its push subscription gets
 * every push encrypted to them, so the push service in between cannot read it.
 */

/** The keys a client supplies, each in URL-safe base64 as RFC 8620 §7.2 asks. */
export interface PushKeys {
  /** The client's P-256 public key, uncompressed: 65 bytes. */
  p256dh: string;
  /** The shared authentication secret: 16 bytes. */
  auth: string;
}

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const PUBLIC_KEY_LENGTH = 65;
const AUTH_LENGTH = 16;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
/** Push services accept bodies up to 4096 bytes; one record of that size is all that is ever sent. */
const RECORD_SIZE = 4096;
const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + PUBLIC_KEY_LENGTH;
/** The longest plaintext that fits: a record less the tag and the one-byte delimiter, less the header. */
export const MAX_PUSH_PLAINTEXT = RECORD_SIZE - HEADER_LENGTH - TAG_LENGTH - 1;

export function decodeBase64Url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  const unpadded = text.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const binary = atob(unpadded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Bytes {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function hkdf(
  salt: Bytes,
  keyMaterial: Bytes,
  info: Bytes,
  length: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'HKDF', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      key,
      length * 8,
    ),
  );
}

interface DecodedKeys {
  publicKey: Bytes;
  auth: Bytes;
  imported: CryptoKey;
}

type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function decodeKeys(keys: PushKeys): Promise<DecodedKeys | null> {
  const publicKey = decodeBase64Url(keys.p256dh);
  const auth = decodeBase64Url(keys.auth);
  if (publicKey?.length !== PUBLIC_KEY_LENGTH || auth?.length !== AUTH_LENGTH) {
    return null;
  }
  try {
    // Importing also checks that the point is on the curve.
    const imported = await crypto.subtle.importKey(
      'raw',
      publicKey,
      CURVE,
      false,
      [],
    );
    return { publicKey, auth, imported };
  } catch {
    return null;
  }
}

/** Whether these keys can be encrypted to: the right sizes, and a real point on the curve. */
export async function isUsablePushKeys(keys: PushKeys): Promise<boolean> {
  return (await decodeKeys(keys)) !== null;
}

/** Values that are random in real use; tests fix them to compare against known results. */
export interface EncryptionOverrides {
  salt?: Uint8Array;
  senderKeys?: { publicKey: CryptoKey; privateKey: CryptoKey };
}

/** Encrypts one push message; the result is the whole request body. */
export async function encryptPush(
  plaintext: Uint8Array,
  keys: PushKeys,
  overrides: EncryptionOverrides = {},
): Promise<Uint8Array> {
  const receiver = await decodeKeys(keys);
  if (!receiver) throw new Error('The push keys are not usable');
  if (plaintext.length > MAX_PUSH_PLAINTEXT) {
    throw new Error(
      `A push message may be at most ${MAX_PUSH_PLAINTEXT} bytes`,
    );
  }

  const sender =
    overrides.senderKeys ??
    (await crypto.subtle.generateKey(CURVE, true, ['deriveBits']));
  const senderPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', sender.publicKey),
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: receiver.imported },
      sender.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.4: mix in the authentication secret and both public keys.
  const keyMaterial = await hkdf(
    receiver.auth,
    shared,
    concat(encoder.encode('WebPush: info\0'), receiver.publicKey, senderPublic),
    32,
  );
  const salt = overrides.salt
    ? new Uint8Array(overrides.salt)
    : crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const contentKey = await hkdf(
    salt,
    keyMaterial,
    encoder.encode('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = await hkdf(
    salt,
    keyMaterial,
    encoder.encode('Content-Encoding: nonce\0'),
    12,
  );

  const key = await crypto.subtle.importKey(
    'raw',
    contentKey,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  // The 0x02 marks the last (here, the only) record.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 },
      key,
      concat(plaintext, Uint8Array.of(2)),
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(
    salt,
    recordSize,
    Uint8Array.of(senderPublic.length),
    senderPublic,
    ciphertext,
  );
}
