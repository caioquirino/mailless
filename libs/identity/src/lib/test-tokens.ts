import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

/** A signing key and what a verifier needs to trust it. For tests only. */
export interface TestKeys {
  privateKey: KeyObject;
  keyId: string;
  jwks: { keys: Array<Record<string, unknown>> };
}

export function testKeys(keyId = 'test-key'): TestKeys {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    privateKey,
    keyId,
    jwks: {
      keys: [
        {
          ...publicKey.export({ format: 'jwk' }),
          kid: keyId,
          alg: 'RS256',
          use: 'sig',
        },
      ],
    },
  };
}

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A signed token with these claims, as a provider would issue it. `exp` is an
 * hour from now unless the claims say otherwise.
 */
export function issueTestToken(
  keys: TestKeys,
  claims: Record<string, unknown>,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'RS256', typ: 'JWT', kid: keys.keyId })}.${encode(
    { iat: now, exp: now + 3600, ...claims },
  )}`;
  const signature = createSign('RSA-SHA256')
    .update(body)
    .sign(keys.privateKey)
    .toString('base64url');
  return `${body}.${signature}`;
}
