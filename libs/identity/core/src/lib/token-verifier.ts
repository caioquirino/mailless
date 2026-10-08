import { JwtVerifier } from 'aws-jwt-verify';

/*
 * Checks the access tokens an OpenID Connect provider issues: the signature
 * against the provider's published keys, who issued it, whom it was issued
 * for, and that it has not expired. Nothing here is particular to one
 * provider; where they differ is in which claim says what, and that is
 * configuration.
 */

export interface TokenVerifierOptions {
  /** The `iss` a token must carry. The provider's keys are found from it. */
  issuer: string;
  /** Where the provider publishes its keys, when not at the usual place under the issuer. */
  jwksUri?: string;
  /** Whom a token may have been issued for; one of them is enough. */
  audiences: readonly string[];
  /**
   * The claim that says whom a token was issued for. `aud` by the
   * specification; Cognito's access tokens say it in `client_id`.
   */
  audienceClaim?: string;
  /** The claim holding the name the user signs in with. `sub` unless told otherwise. */
  usernameClaim?: string;
  /**
   * The claim holding the user's roles, as a list or as one text with spaces
   * or commas. Dots lead into nested objects (`realm_access.roles`), unless
   * the whole name is itself a claim.
   */
  rolesClaim?: string;
  /** Claims a token must carry with exactly these values, such as `token_use: access`. */
  requiredClaims?: Readonly<Record<string, string>>;
  /** Keys to trust without fetching them: for tests, and for hosts that cannot reach the provider. */
  jwks?: { keys: Array<Record<string, unknown>> };
}

export interface VerifiedToken {
  username: string;
  roles: string[];
  scopes: string[];
  claims: Readonly<Record<string, unknown>>;
}

/** The token is not one to act on. The message says why, never what the token held. */
export class TokenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRefusedError';
  }
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

function claimAt(claims: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(claims, name)) return claims[name];
  let value: unknown = claims;
  for (const part of name.split('.')) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !Object.prototype.hasOwnProperty.call(value, part)
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string'
    ? value.split(/[\s,]+/).filter((item) => item.length > 0)
    : [];
}

export function createTokenVerifier(
  options: TokenVerifierOptions,
): TokenVerifier {
  if (options.audiences.length === 0) {
    throw new Error('A token verifier needs at least one audience');
  }
  const audienceClaim = options.audienceClaim ?? 'aud';
  const usernameClaim = options.usernameClaim ?? 'sub';

  const verifier = JwtVerifier.create({
    issuer: options.issuer,
    // Checked below, in whichever claim the provider uses for it.
    audience: null,
    ...(options.jwksUri ? { jwksUri: options.jwksUri } : {}),
  });
  if (options.jwks) {
    verifier.cacheJwks(
      options.jwks as unknown as Parameters<typeof verifier.cacheJwks>[0],
    );
  }

  return async (token) => {
    let claims: Record<string, unknown>;
    try {
      claims = (await verifier.verify(token)) as Record<string, unknown>;
    } catch (error) {
      // The library's messages can quote the token's claims; only the kind of failure is passed on.
      throw new TokenRefusedError(
        `The token was not accepted (${(error as { name?: string }).name ?? 'error'})`,
      );
    }

    const issuedFor = textList(claims[audienceClaim]);
    if (!issuedFor.some((audience) => options.audiences.includes(audience))) {
      throw new TokenRefusedError('The token was issued for something else');
    }
    for (const [name, expected] of Object.entries(
      options.requiredClaims ?? {},
    )) {
      if (claims[name] !== expected) {
        throw new TokenRefusedError(`The token is not of the kind asked for`);
      }
    }
    const username = claims[usernameClaim];
    if (typeof username !== 'string' || username.length === 0) {
      throw new TokenRefusedError('The token does not say whose it is');
    }
    return {
      username,
      roles: options.rolesClaim
        ? textList(claimAt(claims, options.rolesClaim))
        : [],
      scopes: textList(claims['scope'] ?? claims['scp']),
      claims,
    };
  };
}

/**
 * Verifier options from environment variables, the way a deployment hands
 * them over: `OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCES` (a JSON list),
 * `OIDC_AUDIENCE_CLAIM`, `OIDC_USERNAME_CLAIM`, `OIDC_ROLES_CLAIM`,
 * `OIDC_REQUIRED_CLAIMS` (a JSON object) and `OIDC_JWKS` (the provider's keys
 * as JSON, for a host that cannot fetch them). Undefined without an issuer.
 */
export function tokenVerifierOptionsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): TokenVerifierOptions | undefined {
  const issuer = env['OIDC_ISSUER'];
  if (!issuer) return undefined;
  const audiences: unknown = JSON.parse(env['OIDC_AUDIENCES'] ?? '[]');
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    !audiences.every((audience) => typeof audience === 'string')
  ) {
    throw new Error('OIDC_AUDIENCES must be a JSON list of at least one text');
  }
  const required: unknown = JSON.parse(env['OIDC_REQUIRED_CLAIMS'] ?? '{}');
  if (
    typeof required !== 'object' ||
    required === null ||
    Array.isArray(required) ||
    !Object.values(required).every((value) => typeof value === 'string')
  ) {
    throw new Error('OIDC_REQUIRED_CLAIMS must be a JSON object of texts');
  }
  const jwks: unknown = env['OIDC_JWKS']
    ? JSON.parse(env['OIDC_JWKS'])
    : undefined;
  if (
    jwks !== undefined &&
    !Array.isArray((jwks as { keys?: unknown } | null)?.keys)
  ) {
    throw new Error('OIDC_JWKS must be a JSON object with a list of keys');
  }
  const optional = (name: string) => env[name] || undefined;
  const jwksUri = optional('OIDC_JWKS_URI');
  const audienceClaim = optional('OIDC_AUDIENCE_CLAIM');
  const usernameClaim = optional('OIDC_USERNAME_CLAIM');
  const rolesClaim = optional('OIDC_ROLES_CLAIM');
  return {
    issuer,
    audiences: audiences as string[],
    requiredClaims: required as Record<string, string>,
    ...(jwksUri ? { jwksUri } : {}),
    ...(audienceClaim ? { audienceClaim } : {}),
    ...(usernameClaim ? { usernameClaim } : {}),
    ...(rolesClaim ? { rolesClaim } : {}),
    ...(jwks
      ? { jwks: jwks as NonNullable<TokenVerifierOptions['jwks']> }
      : {}),
  };
}
