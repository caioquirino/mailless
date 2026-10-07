/**
 * Maps recipient addresses to account ids. Keys are full addresses
 * (`me@example.com`) or a whole domain (`*@example.com`); an exact address
 * wins over the domain wildcard. Matching is case-insensitive.
 */
export type MailboxMap = Record<string, string>;

export function parseMailboxMap(json: string | undefined): MailboxMap {
  if (!json) return {};
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MAILBOXES must be a JSON object of address to account id');
  }
  const map: MailboxMap = {};
  for (const [address, accountId] of Object.entries(parsed)) {
    if (typeof accountId !== 'string' || accountId === '') {
      throw new Error(
        `MAILBOXES entry "${address}" must be a non-empty string`,
      );
    }
    map[address.toLowerCase()] = accountId;
  }
  return map;
}

export function resolveAccount(
  map: MailboxMap,
  recipient: string,
): string | undefined {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, address)) return map[address];
  const wildcard = `*${address.slice(at)}`;
  return Object.prototype.hasOwnProperty.call(map, wildcard)
    ? map[wildcard]
    : undefined;
}
