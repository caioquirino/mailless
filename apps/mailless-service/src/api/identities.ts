import { createHash } from 'node:crypto';
import type { IdentityInput } from '@mailless/jmap-server';

/**
 * The sending identities of an account, derived from the addresses that
 * deliver to it.
 *
 * Every identity has a real address, because clients put the identity's
 * address in the From header as it is. A `*@domain` entry therefore does not
 * become an identity of its own: it lets the account's identities send as any
 * address at that domain, and if the account has no address there yet, one is
 * made from the account name.
 */
export function identitiesFor(
  accountId: string,
  own: readonly string[],
  name?: string | null,
): IdentityInput[] {
  const wildcards = own.filter((address) => address.startsWith('*@'));
  const addresses = new Set(own.filter((address) => !address.startsWith('*@')));

  for (const wildcard of wildcards) {
    const domain = wildcard.slice(1);
    if (![...addresses].some((address) => address.endsWith(domain))) {
      addresses.add(`${accountId.toLowerCase()}${domain}`);
    }
  }

  const localPart = (address: string) =>
    address.slice(0, address.lastIndexOf('@'));
  const isNamedAfterAccount = (address: string) =>
    localPart(address) === accountId.toLowerCase();

  return (
    [...addresses]
      // The address named after the account first: clients offer the first identity as the default.
      .sort(
        (a, b) =>
          Number(isNamedAfterAccount(b)) - Number(isNamedAfterAccount(a)) ||
          a.localeCompare(b),
      )
      .map((email) => ({
        id: `id${createHash('sha256').update(email).digest('hex').slice(0, 24)}`,
        email,
        ...(name ? { name } : {}),
        allowedFrom: wildcards,
      }))
  );
}
