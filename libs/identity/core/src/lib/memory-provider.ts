import {
  IdentityError,
  type IdentityCapabilities,
  type IdentityProvider,
  type IdentityUser,
  type Passkey,
} from './provider.js';

interface StoredUser extends IdentityUser {
  password: string | null;
  passwordIsTemporary: boolean;
  passkeys: Passkey[];
  /** The secret of their authenticator app, and whether a code from it was confirmed. */
  authenticator: { secret: string; confirmed: boolean } | null;
  sessions: number;
}

export interface InMemoryIdentityOptions {
  /** The roles that exist. A role that does not cannot be granted. */
  roles?: readonly string[];
  minimumPasswordLength?: number;
  now?: () => Date;
}

/**
 * An identity provider held in memory, for tests and for running the
 * interface without a provider at hand. It is the reference for what the
 * interface means. Its access tokens are whatever `signIn` hands out.
 */
export class InMemoryIdentityProvider implements IdentityProvider {
  readonly capabilities: IdentityCapabilities = {
    changeOwnPassword: true,
    manageOwnPasskeys: true,
    removePasskeysOfOthers: false,
    manageOwnAuthenticator: true,
  };

  private readonly users = new Map<string, StoredUser>();
  private readonly tokens = new Map<string, string>();
  /** Secrets handed out and not confirmed yet, by user. */
  private readonly pending = new Map<string, string>();
  private readonly roles: readonly string[];
  private readonly minimumPasswordLength: number;
  private readonly now: () => Date;
  private issued = 0;

  constructor(options: InMemoryIdentityOptions = {}) {
    this.roles = options.roles ?? [];
    this.minimumPasswordLength = options.minimumPasswordLength ?? 14;
    this.now = options.now ?? (() => new Date());
  }

  private require(username: string): StoredUser {
    const user = this.users.get(username);
    if (!user) {
      throw new IdentityError('notFound', `There is no user "${username}"`);
    }
    return user;
  }

  private fromToken(accessToken: string): StoredUser {
    const user = this.users.get(this.tokens.get(accessToken) ?? '');
    if (!user?.enabled) {
      throw new IdentityError('notAuthorized', 'The token is not accepted');
    }
    return user;
  }

  private requirePassword(password: string): void {
    if (password.length < this.minimumPasswordLength) {
      throw new IdentityError(
        'invalidPassword',
        `A password has at least ${this.minimumPasswordLength} characters`,
      );
    }
  }

  private static describe(user: StoredUser): IdentityUser {
    return {
      username: user.username,
      enabled: user.enabled,
      roles: [...user.roles].sort(),
      createdAt: user.createdAt,
    };
  }

  /**
   * Stands in for the provider's sign-in page: an access token for a user
   * who gave the right password, or undefined.
   */
  signIn(username: string, password: string): string | undefined {
    const user = this.users.get(username);
    if (
      !user?.enabled ||
      user.password === null ||
      user.password !== password
    ) {
      return undefined;
    }
    const token = `memory-token-${++this.issued}`;
    this.tokens.set(token, username);
    user.sessions += 1;
    return token;
  }

  /**
   * Stands in for verifying a token: whose it is, or undefined when it is
   * not one this provider stands behind any more.
   */
  whoIs(accessToken: string): IdentityUser | undefined {
    const user = this.users.get(this.tokens.get(accessToken) ?? '');
    return user?.enabled ? InMemoryIdentityProvider.describe(user) : undefined;
  }

  /**
   * Stands in for an authenticator app: the code it shows for a secret. Not
   * a real one, which changes with the time.
   */
  static authenticatorCode(secret: string): string {
    let sum = 0;
    for (const letter of secret) sum = (sum * 31 + letter.charCodeAt(0)) % 1e6;
    return String(sum).padStart(6, '0');
  }

  /** Stands in for the provider's page where a signed-in user adds a passkey. */
  enrolPasskey(accessToken: string, name: string | null = null): Passkey {
    const user = this.fromToken(accessToken);
    const passkey: Passkey = {
      id: `passkey-${++this.issued}`,
      name,
      createdAt: this.now().toISOString(),
    };
    user.passkeys.push(passkey);
    return { ...passkey };
  }

  async getUser(username: string): Promise<IdentityUser | undefined> {
    const user = this.users.get(username);
    return user ? InMemoryIdentityProvider.describe(user) : undefined;
  }

  async listUsers(): Promise<IdentityUser[]> {
    return [...this.users.values()]
      .map(InMemoryIdentityProvider.describe)
      .sort((a, b) => (a.username < b.username ? -1 : 1));
  }

  async createUser(username: string): Promise<IdentityUser> {
    if (username.length === 0) {
      throw new IdentityError('invalid', 'A user needs a name');
    }
    if (this.users.has(username)) {
      throw new IdentityError(
        'exists',
        `The user "${username}" already exists`,
      );
    }
    const user: StoredUser = {
      username,
      enabled: true,
      roles: [],
      createdAt: this.now().toISOString(),
      password: null,
      passwordIsTemporary: false,
      passkeys: [],
      authenticator: null,
      sessions: 0,
    };
    this.users.set(username, user);
    return InMemoryIdentityProvider.describe(user);
  }

  async setEnabled(username: string, enabled: boolean): Promise<void> {
    this.require(username).enabled = enabled;
  }

  async deleteUser(username: string): Promise<void> {
    this.require(username);
    this.users.delete(username);
    for (const [token, owner] of this.tokens) {
      if (owner === username) this.tokens.delete(token);
    }
  }

  async setPassword(
    username: string,
    password: string,
    options: { temporary?: boolean } = {},
  ): Promise<void> {
    const user = this.require(username);
    this.requirePassword(password);
    user.password = password;
    user.passwordIsTemporary = options.temporary ?? false;
  }

  async grantRole(username: string, role: string): Promise<void> {
    const user = this.require(username);
    if (!this.roles.includes(role)) {
      throw new IdentityError('notFound', `There is no role "${role}"`);
    }
    if (!user.roles.includes(role)) user.roles.push(role);
  }

  async revokeRole(username: string, role: string): Promise<void> {
    const user = this.require(username);
    user.roles = user.roles.filter((held) => held !== role);
  }

  async signOutEverywhere(username: string): Promise<void> {
    const user = this.require(username);
    user.sessions = 0;
    for (const [token, owner] of this.tokens) {
      if (owner === username) this.tokens.delete(token);
    }
  }

  async changeOwnPassword(
    accessToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = this.fromToken(accessToken);
    if (user.password !== currentPassword) {
      throw new IdentityError(
        'notAuthorized',
        'The current password is not right',
      );
    }
    this.requirePassword(newPassword);
    user.password = newPassword;
    user.passwordIsTemporary = false;
  }

  async listOwnPasskeys(accessToken: string): Promise<Passkey[]> {
    return this.fromToken(accessToken).passkeys.map((passkey) => ({
      ...passkey,
    }));
  }

  async removeOwnPasskey(accessToken: string, id: string): Promise<void> {
    const user = this.fromToken(accessToken);
    const remaining = user.passkeys.filter((passkey) => passkey.id !== id);
    if (remaining.length === user.passkeys.length) {
      throw new IdentityError('notFound', 'There is no such passkey');
    }
    user.passkeys = remaining;
  }

  async ownAuthenticator(accessToken: string): Promise<{ enabled: boolean }> {
    return {
      enabled: this.fromToken(accessToken).authenticator?.confirmed === true,
    };
  }

  async beginOwnAuthenticator(
    accessToken: string,
  ): Promise<{ secret: string }> {
    const user = this.fromToken(accessToken);
    // A new secret each time, and what was confirmed stays until this one is.
    const secret = `SECRET${++this.issued}`;
    this.pending.set(user.username, secret);
    return { secret };
  }

  async confirmOwnAuthenticator(
    accessToken: string,
    code: string,
  ): Promise<void> {
    const user = this.fromToken(accessToken);
    const secret = this.pending.get(user.username);
    if (
      secret === undefined ||
      code !== InMemoryIdentityProvider.authenticatorCode(secret)
    ) {
      throw new IdentityError('invalidCode', 'The code is not the right one');
    }
    this.pending.delete(user.username);
    user.authenticator = { secret, confirmed: true };
  }

  async removeOwnAuthenticator(accessToken: string): Promise<void> {
    const user = this.fromToken(accessToken);
    this.pending.delete(user.username);
    user.authenticator = null;
  }
}
