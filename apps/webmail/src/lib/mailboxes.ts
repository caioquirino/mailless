import type { Mailbox } from '@mailless/jmap-core';

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

/** Mailboxes in the order people look for them: the known ones first, then the rest by name, each under its parent. */
export function orderMailboxes(
  mailboxes: readonly Mailbox[],
): Array<{ mailbox: Mailbox; depth: number }> {
  const rank = (mailbox: Mailbox) => {
    const index = mailbox.role ? ROLE_ORDER.indexOf(mailbox.role) : -1;
    return index === -1 ? ROLE_ORDER.length : index;
  };
  const sorted = [...mailboxes].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
  const ids = new Set(mailboxes.map((mailbox) => mailbox.id));
  const result: Array<{ mailbox: Mailbox; depth: number }> = [];
  const add = (parentId: string | null, depth: number) => {
    for (const mailbox of sorted) {
      const parent =
        mailbox.parentId !== null && ids.has(mailbox.parentId)
          ? mailbox.parentId
          : null;
      if (parent !== parentId) continue;
      result.push({ mailbox, depth });
      if (depth < 8) add(mailbox.id, depth + 1);
    }
  };
  add(null, 0);
  return result;
}

/** The folders every account comes with, and this page has a place for. */
const GIVEN = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

/**
 * Whether a folder is the person's own to rename, move and remove. One with
 * a role this page has no place for (another program made it, to keep what
 * it calls important, say) is theirs as any other: it is a folder like the rest.
 */
export function ownFolder(mailbox: { role: string | null }): boolean {
  return mailbox.role === null || !GIVEN.includes(mailbox.role);
}
