import type { Email, EmailAddress, Identity } from '@mailless/jmap-core';
import { formatAddresses, nameOf } from './addresses';
import { formatFull } from './format';
import { quotableHtml, textOfHtml } from './html';
import type { Attachment, Draft, Picture } from './mail';

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

/** A message as a page, cut down to what is safe to put inside another message. */
export function htmlOf(email: Email): string {
  const values = email.bodyValues ?? {};
  const shown = email.htmlBody?.length ? email.htmlBody : email.textBody;
  return (shown ?? [])
    .map((part) => {
      const value = part.partId ? (values[part.partId]?.value ?? '') : '';
      return part.type === 'text/html'
        ? quotableHtml(value)
        : preformatted(value.replace(/\r\n/g, '\n').trimEnd());
    })
    .join('');
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

/**
 * What came with a message apart from the pictures its words show in
 * place: those are seen where they belong, and are not listed again.
 */
export function listedAttachments(email: Email): Attachment[] {
  const html = Object.values(email.bodyValues ?? {})
    .map((value) => value.value)
    .join('');
  const shown = new Set(
    (email.attachments ?? [])
      .filter((part) => {
        const cid = part.cid?.replace(/^<|>$/g, '');
        return cid !== undefined && cid !== '' && html.includes(`cid:${cid}`);
      })
      .map((part) => part.blobId),
  );
  return attachmentsOf(email).filter(
    (attachment) => !shown.has(attachment.blobId),
  );
}

/**
 * The pictures of a message that some HTML shows in place: the parts it
 * came with that the HTML points at by their ids.
 */
function picturesIn(email: Email, html: string): Picture[] {
  return (email.attachments ?? []).flatMap((part) => {
    const cid = part.cid?.replace(/^<|>$/g, '');
    return cid && part.blobId && html.includes(`cid:${cid}`)
      ? [
          {
            cid,
            blobId: part.blobId,
            name: part.name ?? 'picture',
            type: part.type,
            size: part.size,
          },
        ]
      : [];
  });
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
 * How someone signs, as it goes into a message's plain words: under the line
 * that mail programs know a signature by ("-- "), so that they can fold it
 * away or leave it out of an answer. Empty when they sign with nothing.
 */
export function signatureBlock(identity: Identity | undefined): string {
  const signature = (identity?.textSignature ?? '').trim();
  return signature === '' ? '' : `-- \n${signature}`;
}

export function escaped(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain words as paragraphs, one to a line, for the editor to start from. */
export function wordsHtml(text: string): string {
  if (text.trim() === '') return '';
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line === '' ? '<p><br></p>' : `<p>${escaped(line)}</p>`))
    .join('');
}

/** Plain words as they were written, inside somebody else's page. */
function preformatted(text: string): string {
  return `<div style="white-space:pre-wrap">${escaped(text)}</div>`;
}

const QUOTE_STYLE =
  'margin:0 0 0 .8ex;border-left:1px solid #c3c9d4;padding-left:1ex';

/**
 * What the editor wrote, as a message carries it: without the editor's own
 * marks, and with what little styling it needs written on each element,
 * since a message brings no stylesheet with it.
 */
export function mailHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const element of [...parsed.body.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const kept =
        (name === 'href' && element.tagName === 'A') ||
        (name === 'value' && element.tagName === 'LI') ||
        (['src', 'alt', 'width'].includes(name) && element.tagName === 'IMG');
      if (!kept) element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'P') element.setAttribute('style', 'margin:0');
    if (element.tagName === 'BLOCKQUOTE') {
      element.setAttribute('style', QUOTE_STYLE);
    }
    if (element.tagName === 'SPAN') element.replaceWith(...element.childNodes);
    if (element.tagName === 'IMG') {
      // Only a picture that goes with the message, never as wide as to push the words aside.
      if (!(element.getAttribute('src') ?? '').startsWith('cid:')) {
        element.remove();
      } else element.setAttribute('style', 'max-width:100%;height:auto');
    }
  }
  // Without the editor's own spacing rule, a run of spaces would close up.
  const walker = parsed.createTreeWalker(parsed.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    node.textContent = (node.textContent ?? '').replace(/ {2}/g, ' \u00a0');
  }
  return parsed.body.innerHTML;
}

function plainLines(node: Node, lines: string[], prefix: string): void {
  let line = '';
  const end = () => {
    lines.push(prefix + line);
    line = '';
  };
  const walk = (inner: Node) => {
    if (inner.nodeType === 3) {
      line += (inner.textContent ?? '').replace(/\u00a0/g, ' ');
      return;
    }
    if (inner.nodeType !== 1) return;
    const element = inner as Element;
    switch (element.tagName) {
      case 'BR':
        // An empty paragraph holds one of these, and is one empty line, not two.
        if (element.parentElement?.childNodes.length !== 1) end();
        return;
      case 'BLOCKQUOTE':
        if (line !== '') end();
        plainLines(element, lines, `${prefix}> `);
        return;
      case 'UL':
      case 'OL': {
        if (line !== '') end();
        [...element.children].forEach((item, index) => {
          const mark = element.tagName === 'OL' ? `${index + 1}. ` : '- ';
          const inside: string[] = [];
          plainLines(item, inside, '');
          inside.forEach((each, at) =>
            lines.push(prefix + (at === 0 ? mark : '  ') + each),
          );
        });
        return;
      }
      case 'A': {
        const before = line.length;
        element.childNodes.forEach(walk);
        const href = element.getAttribute('href') ?? '';
        const shown = line.slice(before).trim();
        const same = [href, href.replace(/^mailto:/, '')].some(
          (each) => each === shown || each === `https://${shown}`,
        );
        if (href !== '' && !same) line += ` <${href}>`;
        return;
      }
      case 'P':
      case 'DIV':
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        if (line !== '') end();
        element.childNodes.forEach(walk);
        end();
        return;
      default:
        element.childNodes.forEach(walk);
    }
  };
  node.childNodes.forEach(walk);
  if (line !== '') end();
}

/** What the editor wrote, as plain words: for mail programs that show nothing else. */
export function plainOf(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [];
  plainLines(parsed.body, lines, '');
  return lines.join('\n').trimEnd();
}

/** How someone signs, in both forms a message carries. */
function signatureOf(identity: Identity | undefined): {
  text: string;
  html: string;
} {
  const text = signatureBlock(identity);
  if (text === '') return { text: '', html: '' };
  const written = (identity?.htmlSignature ?? '').trim();
  const body =
    written !== ''
      ? quotableHtml(written)
      : escaped((identity?.textSignature ?? '').trim()).replace(/\n/g, '<br>');
  return {
    text,
    html: `<div class="mailless-signature" style="color:#5d6676">-- <br>${body}</div>`,
  };
}

/**
 * A message as it is sent or kept: what was written, then the signature,
 * then what it answers. Each is marked, so that a draft opened again comes
 * apart into the same three.
 */
export function bodiesOf(
  draft: Draft,
  identity: Identity | undefined,
): { text: string; html: string } {
  const signature = draft.unsigned
    ? { text: '', html: '' }
    : signatureOf(identity);
  const text = [plainOf(draft.html), signature.text, draft.quote?.text ?? '']
    .filter((part, index) => index === 0 || part !== '')
    .join('\n\n');
  return {
    text: text.trim() === '' ? '' : text,
    html: [
      `<div class="mailless-words">${mailHtml(draft.html)}</div>`,
      signature.html === '' ? '' : `<br>${signature.html}`,
      draft.quote ? `<br>${draft.quote.html}` : '',
    ].join(''),
  };
}

/** The kinds of picture every mail program shows among the words. */
export function isPicture(file: { type: string }): boolean {
  return /^image\/(png|jpeg|gif|webp)$/i.test(file.type);
}

/** Whether what was written speaks of something attached. */
export function mentionsAttachment(html: string): boolean {
  return /\b(attach(ed|ment|ments|ing)?|enclosed)\b/i.test(plainOf(html));
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
    html: '',
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
  const said = `On ${formatFull(email.receivedAt)}, ${
    sender ? nameOf(sender) : 'someone'
  } wrote:`;
  const original = htmlOf(email);
  return {
    identityId: identity.id,
    to: direct,
    cc: others,
    bcc: [],
    subject: prefixed('Re', /^re:/i, email.subject),
    html: '',
    quote: {
      text: `${said}\n${quoted}`,
      html: `<div class="mailless-quote"><div>${escaped(said)}</div><blockquote type="cite" style="${QUOTE_STYLE}">${original}</blockquote></div>`,
    },
    // The pictures what is answered shows in place go along, or it would show gaps.
    pictures: picturesIn(email, original),
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
  const original = htmlOf(email);
  const pictures = picturesIn(email, original);
  const header = [
    '---------- Forwarded message ----------',
    `From: ${formatAddresses(email.from)}`,
    `Date: ${formatFull(email.receivedAt)}`,
    `Subject: ${email.subject ?? ''}`,
    `To: ${formatAddresses(email.to)}`,
    ...(email.cc?.length ? [`Cc: ${formatAddresses(email.cc)}`] : []),
  ];
  return {
    identityId: forwarder.id,
    to: [],
    cc: [],
    bcc: [],
    subject: prefixed('Fwd', /^(fwd?|fw):/i, email.subject),
    html: '',
    quote: {
      text: `${header.join('\n')}\n\n${textOf(email)}`,
      html: `<div class="mailless-quote"><div>${header
        .map(escaped)
        .join('<br>')}</div><br>${original}</div>`,
    },
    pictures,
    // What is shown in place is not also passed on as a file.
    attachments: attachmentsOf(email).filter(
      (attachment) =>
        !pictures.some((picture) => picture.blobId === attachment.blobId),
    ),
    answers: { emailId: email.id, keyword: '$forwarded' },
  };
}

/** Where what a draft answers starts, in its plain words. */
const QUOTED_FROM =
  /(^|\n\n)(On [^\n]* wrote:|-{5,} Forwarded message -{5,})\n/;

/**
 * A kept draft come apart again: what was written, and what it answers. One
 * this webmail kept is marked where each starts; any other is all words.
 */
function parts(
  email: Email,
): Pick<Draft, 'html' | 'quote' | 'unsigned' | 'pictures'> {
  const values = email.bodyValues ?? {};
  const part = (email.htmlBody ?? []).find((each) => each.type === 'text/html');
  const written = part?.partId ? (values[part.partId]?.value ?? '') : '';
  const parsed = new DOMParser().parseFromString(
    quotableHtml(written),
    'text/html',
  );
  const words = parsed.querySelector('.mailless-words');
  if (!words) {
    return {
      html:
        written.trim() === ''
          ? wordsHtml(textOf(email))
          : parsed.body.innerHTML,
      unsigned: true,
    };
  }
  // The pictures the words point at, or what they answer does, which came
  // back as parts of the message.
  const pictures = picturesIn(
    email,
    words.innerHTML +
      (parsed.querySelector('.mailless-quote')?.outerHTML ?? ''),
  );
  const quote = parsed.querySelector('.mailless-quote');
  if (!quote) return { html: words.innerHTML, pictures };
  const text = textOf(email);
  const from = QUOTED_FROM.exec(text);
  return {
    html: words.innerHTML,
    pictures,
    quote: {
      html: quote.outerHTML,
      text: from
        ? text.slice(from.index + (from[1]?.length ?? 0))
        : textOfHtml(quote.outerHTML),
    },
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
  const taken = parts(email);
  return {
    identityId: identity.id,
    to: email.to ?? [],
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    subject: email.subject ?? '',
    ...taken,
    // What is among the words is not also listed under them.
    attachments: attachmentsOf(email).filter(
      (attachment) =>
        !taken.pictures?.some(
          (picture) => picture.blobId === attachment.blobId,
        ),
    ),
    inReplyTo: email.inReplyTo,
    references: email.references,
    replaces: email.id,
  };
}

/** Where a link someone typed leads, or null when it is nowhere a message may link to. */
export function linkAddress(typed: string): string | null {
  const text = typed.trim();
  if (text === '' || /\s/.test(text)) return null;
  if (/^(https?:\/\/|mailto:)\S+$/i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  if (/^[^@/]+@[^@/]+\.[^@/]+$/.test(text)) return `mailto:${text}`;
  return /^[^/]+\.[^/]+/.test(text) ? `https://${text}` : null;
}

/** An address short enough to show on one line: its two ends, when it is long. */
export function shortened(address: string, most = 44): string {
  if (address.length <= most) return address;
  const start = Math.ceil((most - 1) * 0.6);
  return `${address.slice(0, start)}…${address.slice(start - (most - 1))}`;
}

/** A time a message might be sent at instead of now. */
export interface LaterChoice {
  label: string;
  at: Date;
}

/** The times offered for sending later, from now: the next few moments a person would name. */
export function laterChoices(now: Date): LaterChoice[] {
  const day = (days: number, hour: number) => {
    const at = new Date(now);
    at.setDate(at.getDate() + days);
    at.setHours(hour, 0, 0, 0);
    return at;
  };
  const choices: LaterChoice[] = [
    { label: 'In one hour', at: new Date(now.getTime() + 60 * 60 * 1000) },
  ];
  if (now.getHours() < 15) {
    choices.push({ label: 'This afternoon', at: day(0, 16) });
  }
  choices.push({ label: 'Tomorrow morning', at: day(1, 8) });
  // Monday, when tomorrow is not it.
  const untilMonday = (8 - now.getDay()) % 7 || 7;
  if (untilMonday > 1) {
    choices.push({ label: 'Monday morning', at: day(untilMonday, 8) });
  }
  return choices;
}
