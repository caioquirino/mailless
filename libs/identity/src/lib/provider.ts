/*
 * The identity provider is what knows who may sign in and proves it: Cognito,
 * Keycloak, or anything else that speaks OpenID Connect. Signing in happens
 * on the provider's own pages. What is here is the rest: what an
 * administrator does to users, and what a user does to their own credentials
 * once signed in.
 */

export interface IdentityUser {
  /** The name the user signs in with. For mailless it is the account id. */
  username: string;
  /** A user who is not enabled cannot sign in. */
  enabled: boolean;
  roles: string[];
  createdAt: string | null;
}

export interface Passkey {
  id: string;
  /** What the user or their device called it. */
  name: string | null;
  createdAt: string | null;
}

/**
 * What a provider can do. Providers differ, and an interface built on one
 * hides what it cannot offer rather than failing when it is asked for.
 */
export interface IdentityCapabilities {
  /** A signed-in user can change their password through `changeOwnPassword`. */
  changeOwnPassword: boolean;
  /** A signed-in user can list and remove their passkeys here. */
  manageOwnPasskeys: boolean;
  /** An administrator can remove the passkeys of another user. */
  removePasskeysOfOthers: boolean;
}

export interface IdentityProvider {
  readonly capabilities: IdentityCapabilities;

  // What an administrator does.
  getUser(username: string): Promise<IdentityUser | undefined>;
  listUsers(): Promise<IdentityUser[]>;
  /** A user who cannot sign in yet: they have no password until one is set. Fails with `exists`. */
  createUser(username: string): Promise<IdentityUser>;
  setEnabled(username: string, enabled: boolean): Promise<void>;
  deleteUser(username: string): Promise<void>;
  /**
   * Sets a user's password. A temporary one must be replaced by the user the
   * first time they sign in. Fails with `invalidPassword` when the provider
   * will not have it.
   */
  setPassword(
    username: string,
    password: string,
    options?: { temporary?: boolean },
  ): Promise<void>;
  grantRole(username: string, role: string): Promise<void>;
  revokeRole(username: string, role: string): Promise<void>;
  /** Ends every session of a user: what to do when a device is lost. */
  signOutEverywhere(username: string): Promise<void>;

  // What a signed-in user does to their own credentials, proved by their access token.
  changeOwnPassword(
    accessToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void>;
  listOwnPasskeys(accessToken: string): Promise<Passkey[]>;
  removeOwnPasskey(accessToken: string, id: string): Promise<void>;
}

export type IdentityErrorCode =
  | 'exists'
  | 'notFound'
  /** The provider will not have the password: too short, too common, and so on. */
  | 'invalidPassword'
  /** The token or the current password was not accepted. */
  | 'notAuthorized'
  | 'rateLimited'
  /** The provider cannot do this at all; see its capabilities. */
  | 'unsupported'
  | 'invalid';

/** Something the provider refused, with a reason a caller can act on. */
export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}
