import type { AuthContext } from '@mailless/jmap-server';

/** Who else may use an account, by account id: as it is set in Terraform. */
export type AccountShares = Record<
  string,
  { members?: string[]; readers?: string[] }
>;

export function parseAccountShares(json: string | undefined): AccountShares {
  if (!json) return {};
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ACCOUNT_SHARES must be a JSON object');
  }
  return parsed as AccountShares;
}

/**
 * The accounts shared with a user, for their session. A member may change the
 * account; a reader may only read it, and being listed as both means member.
 */
export function sharedAccountsFor(
  shares: AccountShares,
  user: string,
  names: Record<string, string> = {},
): NonNullable<AuthContext['sharedAccounts']> {
  const shared: NonNullable<AuthContext['sharedAccounts']> = {};
  for (const [accountId, share] of Object.entries(shares)) {
    // An account is never shared with its own user: it is theirs already.
    if (accountId === user) continue;
    const isMember = share.members?.includes(user) ?? false;
    const isReader = share.readers?.includes(user) ?? false;
    if (!isMember && !isReader) continue;
    shared[accountId] = {
      name: names[accountId] ?? accountId,
      ...(isMember ? {} : { isReadOnly: true }),
    };
  }
  return shared;
}
