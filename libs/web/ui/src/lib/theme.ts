/*
 * Light or dark. Left alone, a page follows the system. A person who chooses
 * is remembered in this browser, for every mailless page on the site: the
 * choice is written on the page's root, which is what the tokens look at.
 */

/** What the person chose: one of the two, or to follow the system. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** What is shown. */
export type ThemeName = 'light' | 'dark';

export interface ThemeDependencies {
  /** Outlives the tab, and is shared by every page of the site. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The element the choice is written on: the document's root. */
  root: Pick<HTMLElement, 'setAttribute' | 'removeAttribute'>;
  /** What the system asks for, and word of it changing. Left out where it cannot be asked. */
  systemDark?: Pick<
    MediaQueryList,
    'matches' | 'addEventListener' | 'removeEventListener'
  >;
}

const KEY = 'mailless.theme';

export class Theme {
  private current: ThemeChoice = 'system';
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ThemeDependencies) {
    let kept: string | null = null;
    try {
      kept = deps.storage.getItem(KEY);
    } catch {
      // A browser that keeps nothing follows the system.
    }
    if (kept === 'light' || kept === 'dark') this.current = kept;
    this.apply();
    // Following the system means following it when it changes, too.
    deps.systemDark?.addEventListener('change', this.changed);
  }

  /** What the person chose. */
  get choice(): ThemeChoice {
    return this.current;
  }

  /** What is shown: the choice, or what the system asks for. */
  get shown(): ThemeName {
    if (this.current !== 'system') return this.current;
    return this.deps.systemDark?.matches ? 'dark' : 'light';
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed = (): void => {
    for (const listener of [...this.listeners]) listener();
  };

  private apply(): void {
    if (this.current === 'system') this.deps.root.removeAttribute('data-theme');
    else this.deps.root.setAttribute('data-theme', this.current);
  }

  choose(choice: ThemeChoice): void {
    if (choice === this.current) return;
    this.current = choice;
    this.apply();
    try {
      if (choice === 'system') this.deps.storage.removeItem(KEY);
      else this.deps.storage.setItem(KEY, choice);
    } catch {
      // Not remembered, then; it still holds for as long as the page is open.
    }
    this.changed();
  }

  /** The other of the two. Choosing what the system already asks for goes back to following it. */
  toggle(): void {
    const next: ThemeName = this.shown === 'dark' ? 'light' : 'dark';
    const system: ThemeName = this.deps.systemDark?.matches ? 'dark' : 'light';
    this.choose(next === system ? 'system' : next);
  }

  /** Stops listening to the system. For a page that is going away. */
  stop(): void {
    this.deps.systemDark?.removeEventListener('change', this.changed);
  }
}

/** The theme of the page this runs in. */
export function browserTheme(): Theme {
  return new Theme({
    storage: window.localStorage,
    root: document.documentElement,
    ...(typeof window.matchMedia === 'function'
      ? { systemDark: window.matchMedia('(prefers-color-scheme: dark)') }
      : {}),
  });
}
