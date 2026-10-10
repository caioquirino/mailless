import { parseSieve, runSieve } from '@mailless/jmap-core';
import {
  filtersOf,
  ruleOf,
  scriptOf,
  sourceOf,
  summaryOf,
  type Rule,
} from './filters';

const invoices: Rule = {
  name: 'Invoices',
  any: true,
  conditions: [
    { field: 'from', how: 'contains', value: 'nordlys.example' },
    { field: 'subject', how: 'lacks', value: 'offer "now"' },
    { field: 'larger', how: 'contains', value: '10' },
    { field: 'list', how: 'contains', value: '' },
    { field: 'attached', how: 'contains', value: '' },
  ],
  actions: [
    { kind: 'tag', keyword: 'receipts' },
    { kind: 'read' },
    { kind: 'star' },
    { kind: 'move', mailboxId: 'mb1', name: 'Invoices' },
  ],
  stop: true,
};

describe('filters', () => {
  it('writes a filter as script, and reads the same filter back', () => {
    const source = sourceOf(invoices);
    expect(
      parseSieve(scriptOf({ head: '', blocks: [] }) + source).problems,
    ).toEqual([]);
    expect(ruleOf('Invoices', source)).toEqual(invoices);
  });

  it('does what the form says', () => {
    const script = parseSieve(
      scriptOf({
        head: '',
        blocks: [{ name: 'Invoices', on: true, source: '', rule: invoices }],
      }),
    );
    expect(script.problems).toEqual([]);
    expect(
      runSieve(script, {
        headers: [['From', 'Billing <billing@nordlys.example>']],
        size: 100,
      }),
    ).toEqual({
      deliveries: [
        {
          mailbox: 'Invoices',
          mailboxId: 'mb1',
          flags: ['receipts', '\\Seen', '\\Flagged'],
        },
      ],
      discarded: false,
      rules: ['Invoices'],
    });
  });

  it('keeps what the form cannot show as it was written, and what is off as it was', () => {
    const hand =
      'if allof (header :matches "subject" "*receipt*", not exists "list-id") {\n    keep;\n}';
    const script = scriptOf({
      head: '',
      blocks: [
        { name: 'Invoices', on: false, source: '', rule: invoices },
        { name: 'Shops', on: true, source: hand, rule: null },
      ],
    });
    expect(parseSieve(script).problems).toEqual([]);
    // One that is off does nothing.
    expect(parseSieve(script).rules).toEqual([null, 'Shops']);
    const read = filtersOf(script);
    expect(read.blocks).toEqual([
      {
        name: 'Invoices',
        on: false,
        source: sourceOf(invoices),
        rule: invoices,
      },
      { name: 'Shops', on: true, source: hand, rule: null },
    ]);
    // Taken apart and put together, it is the same script.
    expect(scriptOf(read)).toBe(script);
  });

  it('says a filter in a line', () => {
    expect(
      summaryOf(
        { ...invoices, conditions: invoices.conditions.slice(0, 2) },
        { folder: (_id, name) => name, tag: (keyword) => keyword },
      ),
    ).toEqual({
      when: 'from contains “nordlys.example” or subject does not contain “offer "now"”',
      then: 'tag receipts, mark read, star, move to Invoices, then stop',
    });
  });
});
