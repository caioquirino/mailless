import { MethodError } from './errors.js';
import { resolveResultReferences } from './references.js';
import type { Invocation } from './types.js';

const responses: Invocation[] = [
  ['Email/query', { ids: ['e1', 'e2'] }, 'c1'],
  ['Email/get', { list: [{ threadId: 't1' }, { threadId: 't2' }] }, 'c2'],
];

function errorType(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof MethodError) return error.type;
    throw error;
  }
  return undefined;
}

describe('resolveResultReferences', () => {
  it('passes plain arguments through', () => {
    expect(resolveResultReferences({ accountId: 'a' }, responses)).toEqual({
      accountId: 'a',
    });
  });

  it('replaces a reference with the pointed-at value', () => {
    const resolved = resolveResultReferences(
      {
        accountId: 'a',
        '#ids': { resultOf: 'c1', name: 'Email/query', path: '/ids' },
      },
      responses,
    );
    expect(resolved).toEqual({ accountId: 'a', ids: ['e1', 'e2'] });
  });

  it('supports the wildcard path', () => {
    const resolved = resolveResultReferences(
      {
        '#ids': { resultOf: 'c2', name: 'Email/get', path: '/list/*/threadId' },
      },
      responses,
    );
    expect(resolved).toEqual({ ids: ['t1', 't2'] });
  });

  it('rejects an argument given in both forms', () => {
    expect(
      errorType(() =>
        resolveResultReferences(
          {
            ids: [],
            '#ids': { resultOf: 'c1', name: 'Email/query', path: '/ids' },
          },
          responses,
        ),
      ),
    ).toBe('invalidArguments');
  });

  it.each([
    [
      'an unknown call id',
      { resultOf: 'zz', name: 'Email/query', path: '/ids' },
    ],
    ['a mismatched name', { resultOf: 'c1', name: 'Email/get', path: '/ids' }],
    [
      'an unresolvable path',
      { resultOf: 'c1', name: 'Email/query', path: '/x' },
    ],
    ['a malformed reference', { resultOf: 'c1' }],
  ])('rejects %s', (_label, reference) => {
    expect(
      errorType(() =>
        resolveResultReferences({ '#ids': reference }, responses),
      ),
    ).toBe('invalidResultReference');
  });
});
