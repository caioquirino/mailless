import { createHash } from 'node:crypto';
import type { IdentityInput } from '@mailless/jmap-server';
import type { MailboxMap } from '../ingest/recipients.js';

/**
 * The sending identities of an account: one for each address that delivers
 * to it. A `*@domain` entry becomes a wildcard identity, which lets the
 * account send from any address at that domain.
 */
export function identitiesFor(
  mailboxes: MailboxMap,
  accountId: string,
): IdentityInput[] {
  return (
    Object.entries(mailboxes)
      .filter(([, account]) => account === accountId)
      .map(([address]) => address)
      // Exact addresses first: clients tend to offer the first identity as the default.
      .sort(
        (a, b) =>
          Number(a.startsWith('*')) - Number(b.startsWith('*')) ||
          a.localeCompare(b),
      )
      .map((email) => ({
        id: `id${createHash('sha256').update(email).digest('hex').slice(0, 24)}`,
        email,
      }))
  );
}
