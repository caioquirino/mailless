export class PointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PointerError';
  }
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function walk(value: unknown, tokens: string[], index: number): unknown {
  if (index === tokens.length) return value;
  const token = tokens[index] as string;

  if (Array.isArray(value)) {
    if (token === '*') {
      const results: unknown[] = [];
      for (const item of value) {
        const result = walk(item, tokens, index + 1);
        if (Array.isArray(result)) results.push(...result);
        else results.push(result);
      }
      return results;
    }
    if (!ARRAY_INDEX.test(token) || Number(token) >= value.length) {
      throw new PointerError(`Array index "${token}" is out of range`);
    }
    return walk(value[Number(token)], tokens, index + 1);
  }

  if (typeof value === 'object' && value !== null) {
    if (!Object.prototype.hasOwnProperty.call(value, token)) {
      throw new PointerError(`Property "${token}" does not exist`);
    }
    return walk((value as Record<string, unknown>)[token], tokens, index + 1);
  }

  throw new PointerError(`Cannot resolve "${token}" inside a non-container`);
}

/**
 * Evaluates an RFC 6901 JSON Pointer with the JMAP `*` extension (RFC 8620 §3.7):
 * `*` maps the rest of the pointer over an array and flattens array results one level.
 */
export function evaluatePointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) {
    throw new PointerError('A JSON Pointer must be empty or start with "/"');
  }
  return walk(value, pointer.slice(1).split('/').map(unescapeToken), 0);
}
