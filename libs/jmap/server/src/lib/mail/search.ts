import type { EmailAddress } from '@mailless/jmap-core';
import type { MethodContext } from '../context.js';
import { ConflictError, type StoredRecord, type WriteOp } from '../storage.js';
import { htmlToText, partText, type ParsedMessage } from './mime.js';
import { EMAIL, type EmailRecord, type EmailValue } from './model.js';

/*
 * Full-text search (the `text` and `body` filters of RFC 8621 §4.4.1).
 *
 * Each email has a companion record holding its searchable text, already
 * reduced to lower-case words without accents. A search reads those records
 * and looks for the words; there is no separate index to keep in step, and
 * the record is created and destroyed in the same commit as its email.
 */

/** The data type the searchable text of emails is stored under. No JMAP method exposes it. */
export const EMAIL_TEXT = 'EmailText';

/** Raised whenever the stored form changes, so that older records are rebuilt when next needed. */
const TEXT_VERSION = 1;
/** Text beyond this is not searchable. It keeps a record well inside what stores accept for one item. */
const MAX_TEXT_BYTES = 240_000;
const MAX_ATTACHMENT_TEXT_BYTES = 100_000;

export type EmailTextValue = {
  v: number;
  /** The words of the body and of text attachments. */
  body: string;
  /** The words of attachment file names. */
  names: string;
};
type EmailTextRecord = StoredRecord<EmailTextValue>;

const encoder = new TextEncoder();

// Scripts written without spaces between words: each character is a word of its
// own, so that any run of them can be found as a phrase.
const UNSPACED =
  '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}';
const WORD = new RegExp(
  `[${UNSPACED}]|(?:(?![${UNSPACED}])[\\p{L}\\p{N}\\p{M}])+`,
  'gu',
);

function fold(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

export interface Word {
  /** The word as searched for: lower case, without accents. */
  term: string;
  /** Where it is in the original text. */
  start: number;
  end: number;
}

export function words(text: string): Word[] {
  const result: Word[] = [];
  for (const match of text.matchAll(WORD)) {
    const term = fold(match[0]);
    if (term) {
      result.push({
        term,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return result;
}

/**
 * Text in the form it is searched in: its words, each surrounded by spaces.
 * A word, a word prefix or a phrase can then be found with a plain substring
 * search.
 */
export function searchable(text: string, maxBytes = MAX_TEXT_BYTES): string {
  let result = ' ';
  // Every character here is at most 4 bytes; counting them exactly is not worth the time.
  const maxLength = Math.floor(maxBytes / 4);
  for (const { term } of words(text)) {
    if (result.length + term.length + 1 > maxLength) break;
    result += `${term} `;
  }
  return result;
}

export interface SearchQuery {
  /** Each must be found. A phrase is a sequence of words that must be adjacent. */
  phrases: Array<{ terms: string[]; exact: boolean }>;
}

/**
 * Reads what a user typed into a search box. Quoted text is a phrase matched
 * word for word; anything else is a list of words that must all be present,
 * each also matching longer words it begins (so "invoic" finds "invoice").
 */
export function parseSearch(text: string): SearchQuery {
  const phrases: SearchQuery['phrases'] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const quoted = match[1] ?? match[2];
    const terms = words(quoted ?? (match[3] as string)).map(
      (word) => word.term,
    );
    if (terms.length > 0) phrases.push({ terms, exact: quoted !== undefined });
  }
  return { phrases };
}

function needle(phrase: SearchQuery['phrases'][number]): string {
  return ` ${phrase.terms.join(' ')}${phrase.exact ? ' ' : ''}`;
}

/** Whether every phrase of the query occurs in at least one of the texts. */
export function matchesSearch(
  query: SearchQuery,
  texts: readonly string[],
): boolean {
  return query.phrases.every((phrase) => {
    const wanted = needle(phrase);
    return texts.some((text) => text.includes(wanted));
  });
}

function addressText(addresses: EmailAddress[] | null): string {
  return (addresses ?? [])
    .map((address) => `${address.name ?? ''} ${address.email}`)
    .join(' ');
}

/** The header fields a `text` search must cover: From, To, Cc, Bcc and Subject. */
export function searchableHeaders(email: EmailValue): string {
  return searchable(
    [
      addressText(email.from),
      addressText(email.to),
      addressText(email.cc),
      addressText(email.bcc),
      email.subject ?? '',
    ].join('\n'),
  );
}

/** The readable text of a message body: its plain text parts, or its HTML parts without their markup. */
export function bodyText(parsed: ParsedMessage): string {
  const byId = new Map(parsed.parts.map((part) => [part.partId, part]));
  const texts = (ids: readonly string[], type: string) =>
    ids.flatMap((id) => {
      const part = byId.get(id);
      return part?.type === type ? [partText(part).value] : [];
    });
  const plain = texts(parsed.textBody, 'text/plain');
  if (plain.length > 0) return plain.join('\n');
  return texts(parsed.htmlBody, 'text/html').map(htmlToText).join('\n');
}

/** What to store for a message so that it can be searched. */
export function extractText(parsed: ParsedMessage): EmailTextValue {
  const attachments = parsed.parts.filter(
    (part) => part.partId !== null && parsed.attachments.includes(part.partId),
  );
  const pieces = [bodyText(parsed)];
  for (const attachment of attachments) {
    if (!attachment.type.startsWith('text/')) continue;
    const content = partText({
      ...attachment,
      data: attachment.data.subarray(0, MAX_ATTACHMENT_TEXT_BYTES),
    }).value;
    pieces.push(
      attachment.type === 'text/html' ? htmlToText(content) : content,
    );
  }
  return {
    v: TEXT_VERSION,
    body: searchable(pieces.join('\n')),
    names: searchable(
      attachments.map((attachment) => attachment.name ?? '').join('\n'),
      10_000,
    ),
  };
}

export function emailTextOp(id: string, value: EmailTextValue): WriteOp {
  return { kind: 'create', type: EMAIL_TEXT, id, value };
}

/** Operations that remove the text of emails being destroyed, for the same commit. */
export async function destroyTextOps(
  ctx: MethodContext,
  emailIds: readonly string[],
): Promise<WriteOp[]> {
  if (emailIds.length === 0) return [];
  const records = await ctx.store.get(ctx.auth.accountId, EMAIL_TEXT, emailIds);
  return records.map((record) => ({
    kind: 'destroy',
    type: EMAIL_TEXT,
    id: record.id,
    expectedVersion: record.version,
  }));
}

const INDEX_CONCURRENCY = 8;
const MAX_OPS_PER_COMMIT = 20;
const MAX_BYTES_PER_COMMIT = 1_500_000;

async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

async function commitIgnoringRaces(
  ctx: MethodContext,
  ops: WriteOp[],
): Promise<void> {
  try {
    await ctx.store.commit(ctx.auth.accountId, ops);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    if (ops.length === 1) return;
    // One of them was written by someone else in the meantime; the others still need writing.
    for (const op of ops) await commitIgnoringRaces(ctx, [op]);
  }
}

/**
 * The searchable text of the given emails, by email id. Emails stored before
 * search existed (or under an older form of the text) are read from their raw
 * message and stored now, so the first search after an upgrade does the
 * catching up.
 */
export async function loadSearchText(
  ctx: MethodContext,
  emails: readonly EmailRecord[],
  /** Whether `emails` is every email of the account, which allows tidying up. */
  isWholeAccount: boolean,
  parse: (raw: Uint8Array) => Promise<ParsedMessage>,
): Promise<Map<string, EmailTextValue>> {
  const accountId = ctx.auth.accountId;
  const records = (isWholeAccount
    ? await ctx.store.list(accountId, EMAIL_TEXT)
    : await ctx.store.get(
        accountId,
        EMAIL_TEXT,
        emails.map((email) => email.id),
      )) as unknown as EmailTextRecord[];
  const stored = new Map(records.map((record) => [record.id, record]));

  const texts = new Map<string, EmailTextValue>();
  const missing: EmailRecord[] = [];
  for (const email of emails) {
    const record = stored.get(email.id);
    if (record?.value.v === TEXT_VERSION) texts.set(email.id, record.value);
    else missing.push(email);
  }

  if (missing.length > 0) {
    const ops: WriteOp[] = [];
    await inParallel(missing, INDEX_CONCURRENCY, async (email) => {
      const raw = await ctx.blobs.get(accountId, email.value.blobId);
      let value: EmailTextValue = { v: TEXT_VERSION, body: ' ', names: ' ' };
      if (raw) {
        try {
          value = extractText(await parse(raw));
        } catch {
          // A message that cannot be parsed has no searchable text.
        }
      }
      texts.set(email.id, value);
      const outdated = stored.get(email.id);
      ops.push(
        outdated
          ? {
              kind: 'update',
              type: EMAIL_TEXT,
              id: email.id,
              value,
              expectedVersion: outdated.version,
            }
          : emailTextOp(email.id, value),
      );
    });

    let batch: WriteOp[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length > 0) await commitIgnoringRaces(ctx, batch);
      batch = [];
      bytes = 0;
    };
    for (const op of ops) {
      const size =
        op.kind === 'destroy' || op.kind === 'increment'
          ? 0
          : encoder.encode(JSON.stringify(op.value)).length;
      if (
        batch.length >= MAX_OPS_PER_COMMIT ||
        bytes + size > MAX_BYTES_PER_COMMIT
      ) {
        await flush();
      }
      batch.push(op);
      bytes += size;
    }
    await flush();

    // An email destroyed while its text was being written would leave the text behind.
    const still = new Set(
      (
        await ctx.store.get(
          accountId,
          EMAIL,
          missing.map((email) => email.id),
        )
      ).map((record) => record.id),
    );
    const gone = missing.filter((email) => !still.has(email.id));
    const leftovers = await destroyTextOps(
      ctx,
      gone.map((email) => email.id),
    );
    if (leftovers.length > 0) await commitIgnoringRaces(ctx, leftovers);
  }

  if (isWholeAccount) {
    // Text whose email no longer exists is of no use and should not linger.
    const known = new Set(emails.map((email) => email.id));
    const orphans = records.filter((record) => !known.has(record.id));
    if (orphans.length > 0) {
      const existing = new Set(
        (
          await ctx.store.get(
            accountId,
            EMAIL,
            orphans.map((record) => record.id),
          )
        ).map((record) => record.id),
      );
      const ops: WriteOp[] = orphans
        .filter((record) => !existing.has(record.id))
        .map((record) => ({
          kind: 'destroy',
          type: EMAIL_TEXT,
          id: record.id,
          expectedVersion: record.version,
        }));
      for (let start = 0; start < ops.length; start += MAX_OPS_PER_COMMIT) {
        await commitIgnoringRaces(
          ctx,
          ops.slice(start, start + MAX_OPS_PER_COMMIT),
        );
      }
    }
  }

  return texts;
}

// ------------------------------------------------------------ snippets

/** RFC 8621 §5: a snippet's preview is at most 255 octets. */
export const MAX_SNIPPET_BYTES = 255;
const CONTEXT_BEFORE = 40;
const MARK_OPEN = '<mark>';
const MARK_CLOSE = '</mark>';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The spans of `text` that the query matches, in order and without overlaps. */
function matchSpans(
  text: string,
  query: SearchQuery,
): Array<{ start: number; end: number }> {
  const all = words(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (const phrase of query.phrases) {
    const { terms, exact } = phrase;
    for (let index = 0; index + terms.length <= all.length; index++) {
      const found = terms.every((term, offset) => {
        const word = (all[index + offset] as Word).term;
        const isLast = offset === terms.length - 1;
        return isLast && !exact ? word.startsWith(term) : word === term;
      });
      if (found) {
        spans.push({
          start: (all[index] as Word).start,
          end: (all[index + terms.length - 1] as Word).end,
        });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function render(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
  from: number,
  to: number,
): string {
  let result = '';
  let position = from;
  for (const span of spans) {
    if (span.end <= from || span.start >= to) continue;
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    result +=
      escapeHtml(text.slice(position, start)) +
      MARK_OPEN +
      escapeHtml(text.slice(start, end)) +
      MARK_CLOSE;
    position = end;
  }
  return result + escapeHtml(text.slice(position, to));
}

/**
 * The text with every match wrapped in `<mark>` and everything else escaped
 * for HTML, or null when nothing matches. With `maxBytes`, only the part
 * around the first match is returned, cut to fit.
 */
export function highlight(
  text: string,
  query: SearchQuery,
  maxBytes?: number,
): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  const spans = matchSpans(clean, query);
  const first = spans[0];
  if (!first) return null;
  if (maxBytes === undefined) return render(clean, spans, 0, clean.length);

  // Start a little before the first match, at the beginning of a word.
  let from = Math.max(0, first.start - CONTEXT_BEFORE);
  if (from > 0) {
    const space = clean.indexOf(' ', from);
    from = space !== -1 && space < first.start ? space + 1 : first.start;
  }
  let to = clean.length;
  let result = render(clean, spans, from, to);
  // Shorten from the end until it fits; the first match is kept whole when it can be.
  while (encoder.encode(result).length > maxBytes && to > from) {
    const excess = encoder.encode(result).length - maxBytes;
    to = Math.max(from, to - Math.max(1, Math.ceil(excess / 4)));
    // Never cut a character in half.
    if (to > from && /[\uDC00-\uDFFF]/.test(clean[to] ?? '')) to -= 1;
    result = render(clean, spans, from, to);
  }
  return result.includes(MARK_OPEN) ? result : null;
}
