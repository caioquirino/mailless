import type { Email, EmailAddress, Identity } from '@mailless/jmap-core';
import { formatAddresses, nameOf } from './addresses';
import { formatFull } from './format';
import { textOfHtml } from './html';
import type { Attachment, Draft } from './mail';

/** The words of a message, from its plain text where it has one. */
export function textOf(email: Email): string {
  const values = email.bodyValues ?? {};
  return (email.textBody ?? [])
    .map((part) => {
      const value = part.partId ? (values[part.partId]?.value ?? '') : '';
      return part.type === 'text/html' ? textOfHtml(value) : value;
    })
    .join('\n')
    .replace(/\r\n/g, '\n')
    .trimEnd();
}

/** What came with a message: its attached files. */
export function attachmentsOf(email: Email): Attachment[] {
  return (email.attachments ?? [])
    .filter((part) => part.blobId !== null)
    .map((part) => ({
      blobId: part.blobId as string,
      name: part.name ?? 'attachment',
      type: part.type,
      size: part.size,
    }));
}

function prefixed(prefix: string, pattern: RegExp, subject: string | null) {
  const text = (subject ?? '').trim();
  return pattern.test(text) ? text : `${prefix}: ${text}`;
}

/** Who to write as when answering: whoever the message was written to, if that is one of ours. */
function identityFor(email: Email, identities: readonly Identity[]): Identity {
  const addressed = new Set(
    [...(email.to ?? []), ...(email.cc ?? []), ...(email.from ?? [])].map(
      (address) => address.email.toLowerCase(),
    ),
  );
  const identity =
    identities.find((each) => addressed.has(each.email.toLowerCase())) ??
    identities[0];
  if (!identity) throw new Error('This account cannot send mail.');
  return identity;
}

function unique(addresses: EmailAddress[], without: Set<string>) {
  const seen = new Set(without);
  return addresses.filter((address) => {
    const key = address.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * How someone signs, as it goes into a message: under the line that mail
 * programs know a signature by ("-- "), so that they can fold it away or
 * leave it out of an answer. Empty when they sign with nothing.
 */
export function signatureBlock(identity: Identity | undefined): string {
  const signature = (identity?.textSignature ?? '').trim();
  return signature === '' ? '' : `-- \n${signature}`;
}

/** A message being written, signed as someone else: for when who it is from is changed. */
export function swapSignature(
  text: string,
  from: Identity | undefined,
  to: Identity | undefined,
): string {
  const before = signatureBlock(from);
  const after = signatureBlock(to);
  if (before === after) return text;
  if (before !== '' && text.includes(before)) {
    // Signed with nothing now: the gap the signature stood in closes too.
    return after === ''
      ? text.replace(`\n\n${before}`, '').replace(before, '')
      : text.replace(before, after);
  }
  if (after === '') return text;
  // Above what is quoted, when something is; at the end otherwise.
  const quote = /\n\n(On [^\n]* wrote:|-{5,} Forwarded message -{5,})\n/.exec(
    text,
  );
  return quote
    ? `${text.slice(0, quote.index)}\n\n${after}${text.slice(quote.index)}`
    : `${text.trimEnd()}\n\n${after}\n`;
}

export function emptyDraft(identities: readonly Identity[]): Draft {
  const identity = identities[0];
  if (!identity) throw new Error('This account cannot send mail.');
  return {
    identityId: identity.id,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    text: swapSignature('', undefined, identity).trimEnd(),
    attachments: [],
  };
}

/** An answer to a message: to its sender, or with `all` to everyone it was written to as well. */
export function replyDraft(
  email: Email,
  identities: readonly Identity[],
  all: boolean,
): Draft {
  const identity = identityFor(email, identities);
  const mine = new Set(identities.map((each) => each.email.toLowerCase()));
  const from = email.from ?? [];
  // Answering what one sent oneself goes to whoever it was sent to.
  const own = from.some((address) => mine.has(address.email.toLowerCase()));
  const to = own
    ? (email.to ?? [])
    : email.replyTo?.length
      ? email.replyTo
      : from;
  const direct = unique([...to], new Set());
  const others = all
    ? unique(
        [...(own ? [] : (email.to ?? [])), ...(email.cc ?? [])],
        new Set([...mine, ...direct.map((each) => each.email.toLowerCase())]),
      )
    : [];
  const sender = from[0];
  const quoted = textOf(email)
    .split('\n')
    .map((line) => (line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n');
  return {
    identityId: identity.id,
    to: direct,
    cc: others,
    bcc: [],
    subject: prefixed('Re', /^re:/i, email.subject),
    text: swapSignature(
      `\n\nOn ${formatFull(email.receivedAt)}, ${
        sender ? nameOf(sender) : 'someone'
      } wrote:\n${quoted}\n`,
      undefined,
      identity,
    ),
    attachments: [],
    inReplyTo: email.messageId,
    references: [...(email.references ?? []), ...(email.messageId ?? [])],
    answers: { emailId: email.id, keyword: '$answered' },
  };
}

/** A message passed on to someone else, with what was attached to it. */
export function forwardDraft(
  email: Email,
  identities: readonly Identity[],
): Draft {
  const forwarder = identityFor(email, identities);
  const header = [
    '---------- Forwarded message ----------',
    `From: ${formatAddresses(email.from)}`,
    `Date: ${formatFull(email.receivedAt)}`,
    `Subject: ${email.subject ?? ''}`,
    `To: ${formatAddresses(email.to)}`,
    ...(email.cc?.length ? [`Cc: ${formatAddresses(email.cc)}`] : []),
  ].join('\n');
  return {
    identityId: forwarder.id,
    to: [],
    cc: [],
    bcc: [],
    subject: prefixed('Fwd', /^(fwd?|fw):/i, email.subject),
    text: swapSignature(
      `\n\n${header}\n\n${textOf(email)}\n`,
      undefined,
      forwarder,
    ),
    attachments: attachmentsOf(email),
    answers: { emailId: email.id, keyword: '$forwarded' },
  };
}

/** A kept draft, to go on writing. */
export function resumeDraft(
  email: Email,
  identities: readonly Identity[],
): Draft {
  const from = email.from?.[0]?.email.toLowerCase();
  const identity =
    identities.find((each) => each.email.toLowerCase() === from) ??
    identities[0];
  if (!identity) throw new Error('This account cannot send mail.');
  return {
    identityId: identity.id,
    to: email.to ?? [],
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    subject: email.subject ?? '',
    text: textOf(email),
    attachments: attachmentsOf(email),
    inReplyTo: email.inReplyTo,
    references: email.references,
    replaces: email.id,
  };
}
