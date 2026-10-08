import { decodeBase64Url } from './encryption.js';

/*
 * VAPID (RFC 8292): how a push service knows a push comes from this server.
 * The server has one key pair. A client hands the public key to its push
 * service when it subscribes, and the push service then takes pushes for that
 * subscription only from whoever can sign with the private key. Each push
 * carries a short-lived signed token saying which push service it is for.
 *
 * RFC 9749 says how a JMAP server offers its key: in the session, under
 * `urn:ietf:params:jmap:webpush-vapid`.
 */

export interface VapidKeys {
  /** The P-256 public key, uncompressed (65 bytes), in URL-safe base64. This is what the session shows. */
  publicKey: string;
  /** The private key: the 32-byte scalar, in URL-safe base64. Never leaves the server. */
  privateKey: string;
}

export interface VapidOptions extends VapidKeys {
  /**
   * Whom a push service may contact about this server's pushes: a `mailto:`
   * or `https:` URL. Push services may refuse tokens without one.
   */
  subject: string;
}

/** What the engine keeps of the configuration: the public key, and a way to sign. */
export interface Vapid {
  publicKey: string;
  /** The `Authorization` header for a push to this URL. */
  authorization(pushUrl: string): Promise<string>;
}

const PUBLIC_KEY_LENGTH = 65;
const PRIVATE_KEY_LENGTH = 32;
/** How long a token is good for. RFC 8292 allows at most 24 hours. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
/** A token is signed again once it has less than this left, so none arrives nearly expired. */
const TOKEN_MARGIN_SECONDS = 60 * 60;
const MAX_CACHED_TOKENS = 100;
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const encodeJson = (value: unknown): string =>
  encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

/** A new key pair. Made once per deployment: replacing it ends every push subscription made with it. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  );
  return {
    publicKey: encodeBase64Url(publicKey),
    // In a JWK the scalar is already URL-safe base64 without padding.
    privateKey: jwk.d as string,
  };
}

/** Checks the keys and returns what signs with them. Throws when they are not a P-256 pair in the expected form. */
export function createVapid(
  options: VapidOptions,
  now: () => Date = () => new Date(),
): Vapid {
  const point = decodeBase64Url(options.publicKey);
  const scalar = decodeBase64Url(options.privateKey);
  if (
    point?.length !== PUBLIC_KEY_LENGTH ||
    point[0] !== 4 ||
    scalar?.length !== PRIVATE_KEY_LENGTH
  ) {
    throw new Error(
      'VAPID keys must be a P-256 pair: a 65-byte uncompressed public key and a 32-byte private key, in URL-safe base64',
    );
  }
  if (!/^(mailto:.+@.+|https:\/\/.+)$/.test(options.subject)) {
    throw new Error('The VAPID subject must be a mailto: or https: URL');
  }
  const publicKey = encodeBase64Url(point);

  let imported: Promise<CryptoKey> | undefined;
  const key = () =>
    (imported ??= crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: encodeBase64Url(point.subarray(1, 33)),
        y: encodeBase64Url(point.subarray(33, 65)),
        d: encodeBase64Url(scalar),
      },
      ALGORITHM,
      false,
      ['sign'],
    ));

  // One token per push service, used until it is close to expiring.
  const tokens = new Map<string, { token: string; expires: number }>();

  return {
    publicKey,
    async authorization(pushUrl) {
      const audience = new URL(pushUrl).origin;
      const seconds = Math.floor(now().getTime() / 1000);
      let cached = tokens.get(audience);
      if (!cached || cached.expires - seconds < TOKEN_MARGIN_SECONDS) {
        const expires = seconds + TOKEN_LIFETIME_SECONDS;
        const unsigned = `${encodeJson({ typ: 'JWT', alg: 'ES256' })}.${encodeJson(
          { aud: audience, exp: expires, sub: options.subject },
        )}`;
        // WebCrypto signs as r followed by s, which is how a JWT wants it.
        const signature = new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            await key(),
            new TextEncoder().encode(unsigned),
          ),
        );
        cached = {
          token: `${unsigned}.${encodeBase64Url(signature)}`,
          expires,
        };
        if (tokens.size >= MAX_CACHED_TOKENS) {
          tokens.delete(tokens.keys().next().value as string);
        }
        tokens.set(audience, cached);
      }
      return `vapid t=${cached.token}, k=${publicKey}`;
    },
  };
}
