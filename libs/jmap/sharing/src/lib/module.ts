import {
  CAPABILITY_PRINCIPALS,
  CAPABILITY_PRINCIPALS_OWNER,
} from '@mailless/jmap-core';
import type { JmapModule } from '@mailless/jmap-engine';
import { principalMethods } from './principals.js';

/**
 * Sharing for a JMAP server (RFC 9670): who owns each account a user may
 * use, and notices of what was shared with them.
 */
export function sharingModule(): JmapModule {
  return {
    name: 'sharing',
    capabilities: { [CAPABILITY_PRINCIPALS]: {} },
    accountCapabilities: ({ user, accountId }) => ({
      // The principals are kept in the user's own account.
      ...(accountId === user.accountId
        ? {
            [CAPABILITY_PRINCIPALS]: {
              currentUserPrincipalId: user.accountId,
            },
          }
        : {}),
      // Each account belongs to the principal of the same id.
      [CAPABILITY_PRINCIPALS_OWNER]: {
        accountIdForPrincipal: user.accountId,
        principalId: accountId,
      },
    }),
    methods: Object.fromEntries(
      Object.entries(principalMethods).map(([name, handler]) => [
        name,
        { capability: CAPABILITY_PRINCIPALS, handler },
      ]),
    ),
  };
}
