import type { DirectoryReader } from '@mailless/directory';
import type { AuthContext } from '@mailless/jmap-server';

/**
 * The accounts shared with a user, for their session. A member may change the
 * account; a reader may only read it. An account that is not active is not
 * offered to anyone.
 */
export async function sharedAccountsFor(
  directory: DirectoryReader,
  user: string,
): Promise<NonNullable<AuthContext['sharedAccounts']>> {
  const shared: NonNullable<AuthContext['sharedAccounts']> = {};
  for (const [accountId, access] of Object.entries(
    await directory.sharedWith(user),
  )) {
    // An account is never shared with its own user: it is theirs already.
    if (accountId === user) continue;
    const account = await directory.account(accountId);
    if (account?.status !== 'active') continue;
    shared[accountId] = {
      name: account.name ?? accountId,
      ...(access === 'member' ? {} : { isReadOnly: true }),
    };
  }
  return shared;
}
