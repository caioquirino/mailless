import {
  DirectoryError,
  lookupForm,
  normaliseAddress,
  requireAccess,
  requireAccountId,
  requireName,
  requireStatus,
  wildcardFor,
  type Account,
  type Directory,
  type ShareAccess,
} from './directory.js';

/** A directory as plain configuration gives it, for hosts that have no table to keep one in. */
export interface DirectoryConfiguration {
  /** Address, or `*@domain`, to account id. Every account named here exists. */
  mailboxes?: Record<string, string>;
  /** Display name by account id. */
  names?: Record<string, string>;
  /** Who else may use an account, by account id. Being listed as both means member. */
  shares?: Record<string, { members?: string[]; readers?: string[] }>;
}

/**
 * A directory held in memory. It is the reference for what a directory does,
 * and what a host uses when its accounts come from configuration.
 */
export class InMemoryDirectory implements Directory {
  private readonly accounts = new Map<string, Account>();
  /** Address to account id. */
  private readonly addresses = new Map<string, string>();
  /** Account id to user to access. */
  private readonly shares = new Map<string, Map<string, ShareAccess>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** A directory with what the configuration says, checked the same way as changes are. */
  static async from(
    configuration: DirectoryConfiguration,
    now?: () => Date,
  ): Promise<InMemoryDirectory> {
    const directory = new InMemoryDirectory(now);
    const names = configuration.names ?? {};
    const ids = new Set([
      ...Object.values(configuration.mailboxes ?? {}),
      ...Object.keys(configuration.shares ?? {}),
      ...Object.values(configuration.shares ?? {}).flatMap((share) => [
        ...(share.members ?? []),
        ...(share.readers ?? []),
      ]),
    ]);
    for (const id of ids) {
      await directory.createAccount({ id, name: names[id] ?? null });
    }
    for (const [address, id] of Object.entries(configuration.mailboxes ?? {})) {
      await directory.addAddress(id, address);
    }
    for (const [id, share] of Object.entries(configuration.shares ?? {})) {
      for (const user of share.readers ?? []) {
        if (user !== id) await directory.setShare(id, user, 'reader');
      }
      for (const user of share.members ?? []) {
        if (user !== id) await directory.setShare(id, user, 'member');
      }
    }
    return directory;
  }

  private require(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) {
      throw new DirectoryError('notFound', `There is no account "${id}"`);
    }
    return account;
  }

  async resolveAddress(address: string): Promise<string | undefined> {
    const exact = lookupForm(address);
    if (exact === undefined) return undefined;
    return (
      this.addresses.get(exact) ??
      this.addresses.get(wildcardFor(exact) as string)
    );
  }

  async account(id: string): Promise<Account | undefined> {
    const account = this.accounts.get(id);
    return account ? { ...account } : undefined;
  }

  async addressesOf(accountId: string): Promise<string[]> {
    return [...this.addresses]
      .filter(([, id]) => id === accountId)
      .map(([address]) => address)
      .sort();
  }

  async sharedWith(user: string): Promise<Record<string, ShareAccess>> {
    const shared: Record<string, ShareAccess> = {};
    for (const [accountId, users] of this.shares) {
      const access = users.get(user);
      if (access) shared[accountId] = access;
    }
    return shared;
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()]
      .map((account) => ({ ...account }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async createAccount(input: {
    id: string;
    name?: string | null;
  }): Promise<Account> {
    const id = requireAccountId(input.id);
    const name = requireName(input.name);
    if (this.accounts.has(id)) {
      throw new DirectoryError('exists', `The account "${id}" already exists`);
    }
    const account: Account = {
      id,
      name,
      status: 'active',
      createdAt: this.now().toISOString(),
    };
    this.accounts.set(id, account);
    return { ...account };
  }

  async updateAccount(
    id: string,
    changes: { name?: string | null; status?: Account['status'] },
  ): Promise<Account> {
    const account = this.require(id);
    const next = { ...account };
    if (changes.name !== undefined) next.name = requireName(changes.name);
    if (changes.status !== undefined) {
      next.status = requireStatus(changes.status);
    }
    this.accounts.set(id, next);
    return { ...next };
  }

  async deleteAccount(id: string): Promise<void> {
    this.require(id);
    this.accounts.delete(id);
    for (const [address, accountId] of this.addresses) {
      if (accountId === id) this.addresses.delete(address);
    }
    this.shares.delete(id);
    for (const users of this.shares.values()) users.delete(id);
  }

  async addAddress(accountId: string, address: string): Promise<void> {
    const normalised = normaliseAddress(address);
    this.require(accountId);
    const owner = this.addresses.get(normalised);
    if (owner !== undefined && owner !== accountId) {
      throw new DirectoryError(
        'addressTaken',
        'The address already delivers to another account',
      );
    }
    this.addresses.set(normalised, accountId);
  }

  async removeAddress(accountId: string, address: string): Promise<boolean> {
    const normalised = lookupForm(address);
    if (
      normalised === undefined ||
      this.addresses.get(normalised) !== accountId
    ) {
      return false;
    }
    return this.addresses.delete(normalised);
  }

  async sharesOf(accountId: string): Promise<Record<string, ShareAccess>> {
    return Object.fromEntries(this.shares.get(accountId) ?? []);
  }

  async setShare(
    accountId: string,
    user: string,
    access: ShareAccess,
  ): Promise<void> {
    requireAccess(access);
    this.require(accountId);
    this.require(user);
    if (accountId === user) {
      throw new DirectoryError(
        'invalid',
        'An account is its own user’s already',
      );
    }
    const users = this.shares.get(accountId) ?? new Map<string, ShareAccess>();
    users.set(user, access);
    this.shares.set(accountId, users);
  }

  async removeShare(accountId: string, user: string): Promise<boolean> {
    return this.shares.get(accountId)?.delete(user) ?? false;
  }
}
