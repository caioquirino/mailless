import type { Mailbox } from '@mailless/jmap-core';

/*
 * A search, which can be written two ways: as a line of text with words such
 * as `from:` in it, or by filling in a form. Both are the same thing, read
 * into and written out of the one shape below, so that either can be
 * changed and the other follows.
 */

/** How far back to look. Nothing is any time. */
export type Within = '' | '1d' | '1w' | '1m' | '6m' | '1y';

export interface Search {
  /** Words the mail has, anywhere in it. */
  words: string;
  /** Words it does not have. */
  without: string;
  from: string;
  to: string;
  subject: string;
  hasAttachment: boolean;
  unread: boolean;
  within: Within;
  /** Days, as `2026-01-31`: arrived before, or on or after. */
  before: string;
  after: string;
  /** A mailbox, by its name. Nothing is all of them. */
  in: string;
}

export const NO_SEARCH: Search = {
  words: '',
  without: '',
  from: '',
  to: '',
  subject: '',
  hasAttachment: false,
  unread: false,
  within: '',
  before: '',
  after: '',
  in: '',
};

export const WITHIN_NAMES: Record<Within, string> = {
  '': 'Any time',
  '1d': 'In the last day',
  '1w': 'In the last week',
  '1m': 'In the last month',
  '6m': 'In the last six months',
  '1y': 'In the last year',
};

const DAYS: Record<Exclude<Within, ''>, number> = {
  '1d': 1,
  '1w': 7,
  '1m': 31,
  '6m': 183,
  '1y': 366,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The pieces of a line of search: at spaces, but not inside quotes. */
function terms(typed: string): string[] {
  return typed.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

const unquoted = (value: string) => value.replace(/"/g, '').trim();
const quoted = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

/**
 * Reads a line of search. Whatever is not one of the words it knows, or is
 * one with something after it that makes no sense, is taken as words to
 * look for: nothing typed is ever an error.
 */
export function parseSearch(typed: string): Search {
  const search = { ...NO_SEARCH };
  const words: string[] = [];
  const without: string[] = [];
  for (const term of terms(typed)) {
    const named = /^([a-z_]+):(.+)$/i.exec(term);
    const key = named?.[1]?.toLowerCase();
    const value = unquoted(named?.[2] ?? '');
    if (key === 'from' && value) search.from = value;
    else if (key === 'to' && value) search.to = value;
    else if (key === 'subject' && value) search.subject = value;
    else if (key === 'in' && value) search.in = value;
    else if (key === 'has' && /^attachments?$/i.test(value)) {
      search.hasAttachment = true;
    } else if (key === 'is' && /^unread$/i.test(value)) search.unread = true;
    else if (key === 'before' && DAY.test(value)) search.before = value;
    else if (key === 'after' && DAY.test(value)) search.after = value;
    else if (
      (key === 'newer' || key === 'newer_than') &&
      value.toLowerCase() in DAYS
    ) {
      search.within = value.toLowerCase() as Within;
    } else if (/^-[^-\s]/.test(term)) without.push(unquoted(term.slice(1)));
    else words.push(term);
  }
  search.words = words.join(' ');
  search.without = without.filter(Boolean).join(' ');
  return search;
}

/** What narrows a search apart from its words, each as it is typed and as it is shown. */
export interface Narrowing {
  /** Which part of the search it is, to take it out again. */
  key: Exclude<keyof Search, 'words'>;
  /** As it is typed: `from:`. */
  name: string;
  value: string;
}

export function narrowings(search: Search): Narrowing[] {
  const found: Narrowing[] = [];
  const add = (key: Narrowing['key'], name: string, value: string) => {
    if (value !== '') found.push({ key, name, value });
  };
  add('from', 'from:', search.from);
  add('to', 'to:', search.to);
  add('subject', 'subject:', search.subject);
  add('in', 'in:', search.in);
  if (search.hasAttachment) add('hasAttachment', 'has:', 'attachment');
  if (search.unread) add('unread', 'is:', 'unread');
  add('within', 'newer:', search.within);
  add('after', 'after:', search.after);
  add('before', 'before:', search.before);
  for (const word of search.without.split(/\s+/).filter(Boolean)) {
    found.push({ key: 'without', name: '-', value: word });
  }
  return found;
}

/** A search as a line of text: what narrows it, then its words. */
export function formatSearch(search: Search): string {
  return [
    ...narrowings(search).map((each) => `${each.name}${quoted(each.value)}`),
    search.words.trim(),
  ]
    .filter(Boolean)
    .join(' ');
}

export function isEmptySearch(search: Search): boolean {
  return formatSearch(search) === '';
}

/** One search with what another says laid over it: what the other leaves unsaid stays. */
export function mergeSearch(base: Search, over: Search): Search {
  const merged = { ...base };
  for (const key of Object.keys(over) as Array<keyof Search>) {
    const value = over[key];
    if (key === 'words') continue;
    if (key === 'without' && value) {
      merged.without = [base.without, value].filter(Boolean).join(' ');
    } else if (value !== '' && value !== false) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/** A search without one of the things that narrow it. */
export function withoutNarrowing(search: Search, taken: Narrowing): Search {
  if (taken.key === 'without') {
    return {
      ...search,
      without: search.without
        .split(/\s+/)
        .filter((word) => word !== taken.value)
        .join(' '),
    };
  }
  return { ...search, [taken.key]: NO_SEARCH[taken.key] };
}

/**
 * A search as the server is asked it (RFC 8621 §4.4.1). Null when it asks
 * for nothing in particular.
 */
export function filterOf(
  search: Search,
  mailboxes: readonly Mailbox[],
  now: Date = new Date(),
): Record<string, unknown> | null {
  const conditions: Array<Record<string, unknown>> = [];
  const words = unquoted(search.words);
  if (words) conditions.push({ text: words });
  for (const word of search.without.split(/\s+/).filter(Boolean)) {
    conditions.push({ operator: 'NOT', conditions: [{ text: word }] });
  }
  if (search.from) conditions.push({ from: search.from });
  if (search.to) conditions.push({ to: search.to });
  if (search.subject) conditions.push({ subject: search.subject });
  if (search.hasAttachment) conditions.push({ hasAttachment: true });
  if (search.unread) conditions.push({ notKeyword: '$seen' });
  if (search.within) {
    const since = new Date(now.getTime() - DAYS[search.within] * 86_400_000);
    conditions.push({ after: since.toISOString().replace(/\.\d+Z$/, 'Z') });
  }
  if (search.after) conditions.push({ after: `${search.after}T00:00:00Z` });
  if (search.before) conditions.push({ before: `${search.before}T00:00:00Z` });
  if (search.in) {
    const wanted = search.in.toLowerCase();
    const mailbox = mailboxes.find(
      (each) => each.name.toLowerCase() === wanted || each.role === wanted,
    );
    // A mailbox there is none of holds nothing.
    conditions.push({ inMailbox: mailbox?.id ?? 'no-such-mailbox' });
  }
  if (conditions.length === 0) return null;
  return conditions.length === 1
    ? (conditions[0] as Record<string, unknown>)
    : { operator: 'AND', conditions };
}

/** The words that can be typed to narrow a search, to remind whoever is typing. */
export const SEARCH_WORDS: ReadonlyArray<{ typed: string; means: string }> = [
  { typed: 'from:', means: 'who wrote it' },
  { typed: 'to:', means: 'who it was written to' },
  { typed: 'subject:', means: 'what it is about' },
  { typed: 'has:attachment', means: 'with something attached' },
  { typed: 'is:unread', means: 'not read yet' },
  { typed: 'in:', means: 'a mailbox' },
  { typed: 'newer:1m', means: 'from the last month (1d, 1w, 6m, 1y)' },
  { typed: 'before:', means: 'a day, as 2026-01-31; also after:' },
];
