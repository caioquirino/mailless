import { evaluatePointer, PointerError } from './pointer.js';

describe('evaluatePointer', () => {
  const doc = {
    ids: ['a', 'b'],
    list: [
      { id: 'x', emailIds: ['e1', 'e2'], thread: { id: 't1' } },
      { id: 'y', emailIds: ['e3'], thread: { id: 't2' } },
    ],
    'a/b': 1,
    'm~n': 2,
  };

  it('returns the whole document for the empty pointer', () => {
    expect(evaluatePointer(doc, '')).toBe(doc);
  });

  it('resolves object keys and array indexes', () => {
    expect(evaluatePointer(doc, '/ids')).toEqual(['a', 'b']);
    expect(evaluatePointer(doc, '/list/1/id')).toBe('y');
  });

  it('unescapes ~1 and ~0', () => {
    expect(evaluatePointer(doc, '/a~1b')).toBe(1);
    expect(evaluatePointer(doc, '/m~0n')).toBe(2);
  });

  it('maps "*" over arrays', () => {
    expect(evaluatePointer(doc, '/list/*/id')).toEqual(['x', 'y']);
    expect(evaluatePointer(doc, '/list/*/thread/id')).toEqual(['t1', 't2']);
  });

  it('flattens array results of "*" one level', () => {
    expect(evaluatePointer(doc, '/list/*/emailIds')).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
  });

  it.each(['ids', '/missing', '/ids/2', '/ids/01', '/ids/-', '/list/0/id/x'])(
    'rejects %s',
    (pointer) => {
      expect(() => evaluatePointer(doc, pointer)).toThrow(PointerError);
    },
  );

  it('does not resolve inherited properties', () => {
    expect(() => evaluatePointer(doc, '/constructor')).toThrow(PointerError);
  });
});
