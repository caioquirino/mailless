import type { Account, DirectoryReader, ShareAccess } from './directory.js';

export interface CacheOptions {
  /** How long an answer is believed. A change shows up within this time. */
  ttlMs?: number;
  /** The most answers kept; the oldest goes first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Remembers a directory's answers for a short while, so that a service
 * handling many requests does not ask about the same account each time.
 * Failures are never remembered.
 */
export function cachedReader(
  reader: DirectoryReader,
  options: CacheOptions = {},
): DirectoryReader {
  const ttlMs = options.ttlMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: Promise<unknown>; expires: number }>();

  const remember = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value as Promise<T>;
    const value = load();
    if (cache.size >= maxEntries) {
      cache.delete(cache.keys().next().value as string);
    }
    cache.set(key, { value, expires: now() + ttlMs });
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  };

  return {
    resolveAddress: (address) =>
      remember(`r:${address.trim().toLowerCase()}`, () =>
        reader.resolveAddress(address),
      ),
    account: (id) => remember(`a:${id}`, () => reader.account(id)),
    addressesOf: (id) => remember(`d:${id}`, () => reader.addressesOf(id)),
    sharedWith: (user) => remember(`s:${user}`, () => reader.sharedWith(user)),
  };
}

/**
 * Asks a second directory about accounts the first does not have. For moving
 * from one directory to another without a moment at which mail has nowhere to
 * go: `onFallback` says which question the first could not answer.
 */
export function readerWithFallback(
  primary: DirectoryReader,
  fallback: DirectoryReader,
  onFallback?: (question: keyof DirectoryReader) => void,
): DirectoryReader {
  const used = <T>(question: keyof DirectoryReader, answer: T): T => {
    onFallback?.(question);
    return answer;
  };
  /** Whether the first directory knows the account, so that its answer about it stands. */
  const known = async (id: string) => (await primary.account(id)) !== undefined;

  return {
    async resolveAddress(address) {
      const found = await primary.resolveAddress(address);
      if (found !== undefined) return found;
      const other = await fallback.resolveAddress(address);
      return other === undefined ? undefined : used('resolveAddress', other);
    },
    async account(id): Promise<Account | undefined> {
      const found = await primary.account(id);
      if (found) return found;
      const other = await fallback.account(id);
      return other ? used('account', other) : undefined;
    },
    async addressesOf(id) {
      if (await known(id)) return primary.addressesOf(id);
      const other = await fallback.addressesOf(id);
      return other.length > 0 ? used('addressesOf', other) : other;
    },
    async sharedWith(user): Promise<Record<string, ShareAccess>> {
      if (await known(user)) return primary.sharedWith(user);
      const other = await fallback.sharedWith(user);
      return Object.keys(other).length > 0 ? used('sharedWith', other) : other;
    },
  };
}
