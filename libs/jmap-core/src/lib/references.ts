import { MethodError } from './errors.js';
import { evaluatePointer, PointerError } from './pointer.js';
import type { Invocation, ResultReference } from './types.js';

function isResultReference(value: unknown): value is ResultReference {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['resultOf'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['path'] === 'string'
  );
}

/**
 * Replaces every `#name` argument with the value its ResultReference points at
 * in the responses produced so far (RFC 8620 §3.7).
 */
export function resolveResultReferences(
  args: Record<string, unknown>,
  previousResponses: readonly Invocation[],
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith('#')) {
      resolved[key] = value;
      continue;
    }

    const name = key.slice(1);
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      throw new MethodError(
        'invalidArguments',
        `"${name}" is given both directly and as a result reference`,
      );
    }
    if (!isResultReference(value)) {
      throw new MethodError(
        'invalidResultReference',
        `"${key}" is not a ResultReference object`,
      );
    }

    const source = previousResponses.find(
      (response) => response[2] === value.resultOf,
    );
    if (!source || source[0] !== value.name) {
      throw new MethodError(
        'invalidResultReference',
        `No "${value.name}" response with call id "${value.resultOf}"`,
      );
    }

    try {
      resolved[name] = evaluatePointer(source[1], value.path);
    } catch (error) {
      if (error instanceof PointerError) {
        throw new MethodError(
          'invalidResultReference',
          `Path "${value.path}" could not be resolved: ${error.message}`,
        );
      }
      throw error;
    }
  }

  return resolved;
}
