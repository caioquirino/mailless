import type { Mailbox } from '@mailless/jmap-core';
import {
  filterOf,
  formatSearch,
  mergeSearch,
  narrowings,
  NO_SEARCH,
  parseSearch,
  withoutNarrowing,
} from './search';

describe('a search', () => {
  const typed =
    'from:marta@northwind.example has:attachment newer:1m contract "fee schedule" -draft';

  it('is read from what is typed', () => {
    expect(parseSearch(typed)).toEqual({
      ...NO_SEARCH,
      from: 'marta@northwind.example',
      hasAttachment: true,
      within: '1m',
      words: 'contract "fee schedule"',
      without: 'draft',
    });
    expect(
      parseSearch('to:"Bob Stone" subject:lunch in:Archive is:unread'),
    ).toMatchObject({
      to: 'Bob Stone',
      subject: 'lunch',
      in: 'Archive',
      unread: true,
    });
    expect(
      parseSearch('after:2026-01-01 before:2026-02-01 newer_than:1W'),
    ).toMatchObject({
      after: '2026-01-01',
      before: '2026-02-01',
      within: '1w',
    });
  });

  it('takes what it does not know as words to look for, and never as an error', () => {
    expect(
      parseSearch('form:marta has:wings before:soon 10:30 from:').words,
    ).toBe('form:marta has:wings before:soon 10:30 from:');
    expect(parseSearch('  ').words).toBe('');
  });

  it('is written out as it would be typed, and read back the same', () => {
    const search = parseSearch(typed);
    expect(formatSearch(search)).toBe(
      'from:marta@northwind.example has:attachment newer:1m -draft contract "fee schedule"',
    );
    expect(parseSearch(formatSearch(search))).toEqual(search);
    expect(formatSearch(parseSearch('to:"Bob Stone"'))).toBe('to:"Bob Stone"');
    expect(formatSearch(NO_SEARCH)).toBe('');
  });

  it('says what narrows it, each of which can be taken out', () => {
    const search = parseSearch(`${typed} -old`);
    const narrowed = narrowings(search);
    expect(narrowed.map((each) => `${each.name}${each.value}`)).toEqual([
      'from:marta@northwind.example',
      'has:attachment',
      'newer:1m',
      '-draft',
      '-old',
    ]);
    const less = withoutNarrowing(
      withoutNarrowing(search, narrowed[1] as never),
      narrowed[3] as never,
    );
    expect(formatSearch(less)).toBe(
      'from:marta@northwind.example newer:1m -old contract "fee schedule"',
    );
  });

  it('takes more from what is typed after it, and keeps the rest', () => {
    const merged = mergeSearch(
      parseSearch('from:bob has:attachment -a'),
      parseSearch('from:carol is:unread -b words'),
    );
    expect(formatSearch(merged)).toBe(
      'from:carol has:attachment is:unread -a -b',
    );
  });

  it('is asked of the server as the conditions it is made of', () => {
    const mailboxes = [
      { id: 'mb1', name: 'Inbox', role: 'inbox' },
      { id: 'mb2', name: 'Projects', role: null },
    ] as Mailbox[];
    const now = new Date('2026-03-01T12:00:00Z');
    expect(filterOf(parseSearch('contract'), mailboxes, now)).toEqual({
      text: 'contract',
    });
    expect(filterOf(NO_SEARCH, mailboxes, now)).toBeNull();
    expect(
      filterOf(
        parseSearch(
          'from:marta has:attachment is:unread newer:1w in:projects after:2026-01-01 contract -draft',
        ),
        mailboxes,
        now,
      ),
    ).toEqual({
      operator: 'AND',
      conditions: [
        { text: 'contract' },
        { operator: 'NOT', conditions: [{ text: 'draft' }] },
        { from: 'marta' },
        { hasAttachment: true },
        { notKeyword: '$seen' },
        { after: '2026-02-22T12:00:00Z' },
        { after: '2026-01-01T00:00:00Z' },
        { inMailbox: 'mb2' },
      ],
    });
    // By what a mailbox is for, too; and one there is none of holds nothing.
    expect(filterOf(parseSearch('in:inbox'), mailboxes, now)).toEqual({
      inMailbox: 'mb1',
    });
    expect(filterOf(parseSearch('in:nowhere'), mailboxes, now)).toEqual({
      inMailbox: 'no-such-mailbox',
    });
  });
});
