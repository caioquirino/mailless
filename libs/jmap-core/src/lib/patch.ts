export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

export type PatchObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function splitPath(path: string): string[] {
  return path
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Applies a JMAP PatchObject (RFC 8620 §5.3) and returns a new object.
 * A null value at a nested path removes that key; at the top level it sets the property to null.
 */
export function applyPatch<T extends Record<string, unknown>>(
  target: T,
  patch: PatchObject,
): T {
  const paths = Object.keys(patch);
  for (const a of paths) {
    for (const b of paths) {
      if (a !== b && b.startsWith(`${a}/`)) {
        throw new PatchError(`Patch "${a}" is a prefix of patch "${b}"`);
      }
    }
  }

  const result = cloneJson(target) as Record<string, unknown>;

  for (const path of paths) {
    const tokens = splitPath(path);
    if (tokens.includes('__proto__')) {
      throw new PatchError(`Patch "${path}" uses a reserved property name`);
    }
    const value = cloneJson(patch[path]);
    const last = tokens[tokens.length - 1] as string;

    let container = result;
    for (const token of tokens.slice(0, -1)) {
      const next = Object.prototype.hasOwnProperty.call(container, token)
        ? container[token]
        : undefined;
      if (!isPlainObject(next)) {
        throw new PatchError(
          `Patch "${path}" does not point inside an existing object`,
        );
      }
      container = next;
    }

    if (tokens.length > 1 && value === null) delete container[last];
    else container[last] = value;
  }

  return result as T;
}

/** The top-level property names a PatchObject touches. */
export function patchedProperties(patch: PatchObject): string[] {
  return [
    ...new Set(Object.keys(patch).map((path) => splitPath(path)[0] as string)),
  ];
}
