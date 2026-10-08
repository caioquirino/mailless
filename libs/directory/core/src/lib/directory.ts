/*
 * The directory says who has a mailbox: the accounts, the addresses that
 * deliver to each, and which accounts are shared with whom. It knows nothing
 * of mail or of how people sign in.
 */

/** `disabled`: kept, but nobody may sign in. `deleting`: on its way out; nothing is delivered. */
export type AccountStatus = 'active' | 'disabled' | 'deleting';

export interface Account {
  /** Never changes. It is also the name the account's user signs in with. */
  id: string;
  /** Shown as the sender of the account's mail. */
  name: string | null;
  status: AccountStatus;
  /**
   * The most mail the account may hold, in octets, when it has a limit of its
   * own. Null leaves it to whatever the deployment gives every account.
   */
  quotaOctets: number | null;
  createdAt: string;
}

/** A member may change a shared account; a reader may only read it. */
export type ShareAccess = 'member' | 'reader';

/** What the services that handle mail need to know. */
export interface DirectoryReader {
  /**
   * The account an address delivers to. An exact address wins over a whole
   * domain (`*@example.com`). Capitals make no difference.
   */
  resolveAddress(address: string): Promise<string | undefined>;
  account(id: string): Promise<Account | undefined>;
  /** The addresses that deliver to an account, whole domains included, sorted. */
  addressesOf(accountId: string): Promise<string[]>;
  /** The other accounts a user may use, by account id. */
  sharedWith(user: string): Promise<Record<string, ShareAccess>>;
}

export interface Directory extends DirectoryReader {
  listAccounts(): Promise<Account[]>;
  /** Fails with `exists` when the id is taken. */
  createAccount(account: {
    id: string;
    name?: string | null;
  }): Promise<Account>;
  updateAccount(
    id: string,
    changes: {
      name?: string | null;
      status?: AccountStatus;
      quotaOctets?: number | null;
    },
  ): Promise<Account>;
  /** Removes the account with its addresses and every share to or from it. */
  deleteAccount(id: string): Promise<void>;
  /** Fails with `addressTaken` when the address delivers to another account. */
  addAddress(accountId: string, address: string): Promise<void>;
  /** False when the address did not deliver to the account. */
  removeAddress(accountId: string, address: string): Promise<boolean>;
  /** Who may use an account besides its own user, by user. */
  sharesOf(accountId: string): Promise<Record<string, ShareAccess>>;
  setShare(accountId: string, user: string, access: ShareAccess): Promise<void>;
  /** False when the account was not shared with the user. */
  removeShare(accountId: string, user: string): Promise<boolean>;
}

export type DirectoryErrorCode =
  'exists' | 'notFound' | 'addressTaken' | 'invalid';

/** A change the directory refuses, with a reason a caller can act on. */
export class DirectoryError extends Error {
  constructor(
    readonly code: DirectoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DirectoryError';
  }
}

/**
 * Small letters only: identity providers differ on whether capitals matter in
 * a username, and two accounts must never be told apart by them alone.
 */
const ACCOUNT_ID = /^[a-z0-9_-]{1,64}$/;
const ADDRESS = /^[^@\s]+@[^@\s]+$/;
const STATUSES: readonly string[] = ['active', 'disabled', 'deleting'];
const MAX_NAME_LENGTH = 200;

export function isAccountId(id: string): boolean {
  return ACCOUNT_ID.test(id);
}

export function requireAccountId(id: string): string {
  if (!isAccountId(id)) {
    throw new DirectoryError(
      'invalid',
      'An account id is 1 to 64 small letters, digits, "-" or "_"',
    );
  }
  return id;
}

/** An address as the directory keeps it: trimmed, in small letters. */
export function normaliseAddress(address: string): string {
  const normalised = address.trim().toLowerCase();
  if (!ADDRESS.test(normalised) || normalised.length > 320) {
    throw new DirectoryError(
      'invalid',
      'An address is name@domain, or *@domain for a whole domain',
    );
  }
  return normalised;
}

export function requireName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_NAME_LENGTH ||
    /[\r\n]/.test(trimmed)
  ) {
    throw new DirectoryError(
      'invalid',
      `A name is one line of 1 to ${MAX_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

/** The smallest limit an account may be given: less would not hold a message with a picture. */
export const MIN_QUOTA_OCTETS = 1024 * 1024;

export function requireQuota(octets: number | null | undefined): number | null {
  if (octets === null || octets === undefined) return null;
  if (!Number.isSafeInteger(octets) || octets < MIN_QUOTA_OCTETS) {
    throw new DirectoryError(
      'invalid',
      `A quota is a whole number of octets, at least ${MIN_QUOTA_OCTETS}`,
    );
  }
  return octets;
}

export function requireStatus(status: string): AccountStatus {
  if (!STATUSES.includes(status)) {
    throw new DirectoryError(
      'invalid',
      'A status is active, disabled or deleting',
    );
  }
  return status as AccountStatus;
}

export function requireAccess(access: string): ShareAccess {
  if (access !== 'member' && access !== 'reader') {
    throw new DirectoryError('invalid', 'Access is member or reader');
  }
  return access;
}

/** The whole-domain entry that would also deliver an address, or undefined for one without a domain. */
export function wildcardFor(address: string): string | undefined {
  const at = address.lastIndexOf('@');
  return at <= 0 ? undefined : `*${address.slice(at)}`;
}

/** An address as it is looked up: undefined for what cannot be an address at all. */
export function lookupForm(address: string): string | undefined {
  const normalised = address.trim().toLowerCase();
  return ADDRESS.test(normalised) ? normalised : undefined;
}
