import { useCallback, useState } from 'react';

/**
 * Something about how the page is laid out that is worth remembering in
 * this browser: a width, whether a panel is folded. Nothing of anyone's
 * mail. Where nothing can be kept, it holds for as long as the page is open.
 */
export function usePreference<T extends number | boolean | string>(
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const kept: unknown = JSON.parse(
        window.localStorage.getItem(key) ?? 'null',
      );
      return typeof kept === typeof fallback ? (kept as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not remembered, then.
      }
    },
    [key],
  );
  return [value, set];
}
