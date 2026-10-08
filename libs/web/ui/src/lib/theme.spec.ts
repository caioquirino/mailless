import { Theme } from './theme.js';

function system(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  };
  return {
    query: query as unknown as MediaQueryList,
    listeners,
    set(value: boolean) {
      query.matches = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

const make = (dark = false) => {
  const os = system(dark);
  const theme = new Theme({
    storage: window.localStorage,
    root: document.documentElement,
    systemDark: os.query,
  });
  return { theme, os };
};
const written = () => document.documentElement.getAttribute('data-theme');

describe('Theme', () => {
  it('follows the system until someone chooses, and when the system changes', () => {
    const { theme, os } = make(true);
    const told = vi.fn();
    theme.subscribe(told);
    expect(theme.choice).toBe('system');
    expect(theme.shown).toBe('dark');
    // Nothing is written on the page: the stylesheet asks the system itself.
    expect(written()).toBeNull();

    os.set(false);
    expect(theme.shown).toBe('light');
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('holds to a choice whatever the system says, and remembers it', () => {
    const { theme, os } = make(false);
    theme.choose('dark');
    expect(theme.shown).toBe('dark');
    expect(written()).toBe('dark');
    os.set(true);
    os.set(false);
    expect(theme.shown).toBe('dark');

    // Another page of the site, or this one after a reload.
    const again = make(false).theme;
    expect(again.choice).toBe('dark');
    expect(written()).toBe('dark');
  });

  it('switches to the other of the two, and back to following the system', () => {
    const { theme } = make(false);
    theme.toggle();
    expect(theme.choice).toBe('dark');
    expect(written()).toBe('dark');
    // Light is what the system asks for: choosing it is choosing nothing.
    theme.toggle();
    expect(theme.choice).toBe('system');
    expect(theme.shown).toBe('light');
    expect(written()).toBeNull();
    expect(window.localStorage.getItem('mailless.theme')).toBeNull();
  });

  it('works where nothing can be kept and the system cannot be asked', () => {
    const theme = new Theme({
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => undefined,
      },
      root: document.documentElement,
    });
    expect(theme.shown).toBe('light');
    theme.choose('dark');
    expect(theme.shown).toBe('dark');
    expect(written()).toBe('dark');
  });

  it('stops listening when told to', () => {
    const { theme, os } = make();
    expect(os.listeners.size).toBe(1);
    theme.stop();
    expect(os.listeners.size).toBe(0);
  });
});
