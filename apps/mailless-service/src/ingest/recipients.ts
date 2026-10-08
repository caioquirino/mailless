/**
 * Recipient addresses to account ids, as configuration gives them. Keys are
 * full addresses (`me@example.com`) or a whole domain (`*@example.com`).
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
