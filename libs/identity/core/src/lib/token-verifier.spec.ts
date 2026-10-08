import { issueTestToken, testKeys } from './test-tokens.js';
import {
  createTokenVerifier,
  TokenRefusedError,
  tokenVerifierOptionsFromEnvironment,
} from './token-verifier.js';

const ISSUER = 'https://id.example.com/realm';
const keys = testKeys();

describe('createTokenVerifier', () => {
  const verify = createTokenVerifier({
    issuer: ISSUER,
    audiences: ['mail', 'admin'],
    usernameClaim: 'preferred_username',
    rolesClaim: 'realm_access.roles',
    jwks: keys.jwks,
  });
  const claims = {
    iss: ISSUER,
    aud: ['admin', 'account'],
    sub: 'user-123',
    preferred_username: 'ann',
    realm_access: { roles: ['MAILLESS_ADMIN', 'user'] },
    scope: 'openid profile',
  };

  it('accepts a token from the issuer, for one of the audiences, and reads who it is', async () => {
    const verified = await verify(issueTestToken(keys, claims));
    expect(verified).toMatchObject({
      username: 'ann',
      roles: ['MAILLESS_ADMIN', 'user'],
      scopes: ['openid', 'profile'],
    });
    expect(verified.claims['sub']).toBe('user-123');
  });

  it('refuses what it should not act on, without saying what the token held', async () => {
    const refused = async (token: string) => {
      const error = await verify(token).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TokenRefusedError);
      expect((error as Error).message).not.toMatch(/ann|user-123|other-app/);
      return (error as Error).message;
    };
    const with_ = (changes: Record<string, unknown>) =>
      issueTestToken(keys, { ...claims, ...changes });

    await refused('not a token');
    await refused(with_({ iss: 'https://elsewhere.example.com' }));
    await refused(with_({ exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(await refused(with_({ aud: 'other-app' }))).toMatch(
      /issued for something else/,
    );
    expect(await refused(with_({ aud: undefined }))).toMatch(
      /issued for something else/,
    );
    expect(await refused(with_({ preferred_username: undefined }))).toMatch(
      /whose it is/,
    );
    // Signed by a key the issuer does not publish.
    await refused(issueTestToken(testKeys(), claims));
    // Tampered with after signing.
    const [header, , signature] = issueTestToken(keys, claims).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims, preferred_username: 'root' }),
    ).toString('base64url');
    await refused(`${header}.${forged}.${signature}`);
  });

  it('reads the audience, the roles and the kind of token from wherever the provider puts them', async () => {
    // As Cognito issues access tokens: no `aud`, groups in a claim with a colon.
    const cognito = createTokenVerifier({
      issuer: ISSUER,
      audiences: ['client-1'],
      audienceClaim: 'client_id',
      usernameClaim: 'username',
      rolesClaim: 'cognito:groups',
      requiredClaims: { token_use: 'access' },
      jwks: keys.jwks,
    });
    const token = (changes: Record<string, unknown> = {}) =>
      issueTestToken(keys, {
        iss: ISSUER,
        client_id: 'client-1',
        username: 'ann',
        token_use: 'access',
        'cognito:groups': ['MAILLESS_ADMIN'],
        scope: 'openid aws.cognito.signin.user.admin',
        ...changes,
      });
    expect(await cognito(token())).toMatchObject({
      username: 'ann',
      roles: ['MAILLESS_ADMIN'],
      scopes: ['openid', 'aws.cognito.signin.user.admin'],
    });
    expect(
      (await cognito(token({ 'cognito:groups': undefined }))).roles,
    ).toEqual([]);
    await expect(cognito(token({ token_use: 'id' }))).rejects.toThrow(
      /not of the kind/,
    );
    await expect(cognito(token({ client_id: 'client-2' }))).rejects.toThrow(
      TokenRefusedError,
    );

    // Roles as one text, and no roles claim configured at all.
    const plain = createTokenVerifier({
      issuer: ISSUER,
      audiences: ['mail'],
      rolesClaim: 'roles',
      jwks: keys.jwks,
    });
    expect(
      (
        await plain(
          issueTestToken(keys, {
            iss: ISSUER,
            aud: 'mail',
            sub: 'ann',
            roles: 'a, b c',
          }),
        )
      ).roles,
    ).toEqual(['a', 'b', 'c']);
    const none = createTokenVerifier({
      issuer: ISSUER,
      audiences: ['mail'],
      jwks: keys.jwks,
    });
    expect(
      await none(
        issueTestToken(keys, {
          iss: ISSUER,
          aud: 'mail',
          sub: 'ann',
          roles: ['a'],
        }),
      ),
    ).toMatchObject({ username: 'ann', roles: [], scopes: [] });
  });

  it('needs to know whom tokens are for', () => {
    expect(() =>
      createTokenVerifier({ issuer: ISSUER, audiences: [] }),
    ).toThrow(/at least one audience/);
  });
});

describe('tokenVerifierOptionsFromEnvironment', () => {
  it('reads the options a deployment hands over', () => {
    expect(tokenVerifierOptionsFromEnvironment({})).toBeUndefined();
    expect(
      tokenVerifierOptionsFromEnvironment({
        OIDC_ISSUER: ISSUER,
        OIDC_JWKS_URI: `${ISSUER}/keys`,
        OIDC_AUDIENCES: '["a","b"]',
        OIDC_AUDIENCE_CLAIM: 'client_id',
        OIDC_USERNAME_CLAIM: 'username',
        OIDC_ROLES_CLAIM: 'cognito:groups',
        OIDC_REQUIRED_CLAIMS: '{"token_use":"access"}',
      }),
    ).toEqual({
      issuer: ISSUER,
      jwksUri: `${ISSUER}/keys`,
      audiences: ['a', 'b'],
      audienceClaim: 'client_id',
      usernameClaim: 'username',
      rolesClaim: 'cognito:groups',
      requiredClaims: { token_use: 'access' },
    });
    expect(
      tokenVerifierOptionsFromEnvironment({
        OIDC_ISSUER: ISSUER,
        OIDC_AUDIENCES: '["a"]',
        OIDC_JWKS_URI: '',
      }),
    ).toEqual({ issuer: ISSUER, audiences: ['a'], requiredClaims: {} });
  });

  it('takes the provider’s keys from the environment when they cannot be fetched', async () => {
    const options = tokenVerifierOptionsFromEnvironment({
      OIDC_ISSUER: ISSUER,
      OIDC_AUDIENCES: '["mail"]',
      OIDC_JWKS: JSON.stringify(keys.jwks),
    });
    const verify = createTokenVerifier(options as NonNullable<typeof options>);
    expect(
      await verify(
        issueTestToken(keys, { iss: ISSUER, aud: 'mail', sub: 'ann' }),
      ),
    ).toMatchObject({ username: 'ann' });
    expect(() =>
      tokenVerifierOptionsFromEnvironment({
        OIDC_ISSUER: ISSUER,
        OIDC_AUDIENCES: '["mail"]',
        OIDC_JWKS: '{"keys":"none"}',
      }),
    ).toThrow(/OIDC_JWKS/);
  });

  it('says what is wrong with them', () => {
    expect(() =>
      tokenVerifierOptionsFromEnvironment({ OIDC_ISSUER: ISSUER }),
    ).toThrow(/OIDC_AUDIENCES/);
    expect(() =>
      tokenVerifierOptionsFromEnvironment({
        OIDC_ISSUER: ISSUER,
        OIDC_AUDIENCES: '["a"]',
        OIDC_REQUIRED_CLAIMS: '{"a":1}',
      }),
    ).toThrow(/OIDC_REQUIRED_CLAIMS/);
  });
});
