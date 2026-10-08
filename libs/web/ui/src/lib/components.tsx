import {
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { ICONS, type IconName } from './icons.js';
import type { Theme } from './theme.js';

/*
 * The things every mailless page is made of. Each draws with the classes of
 * base.css and the tokens, and none holds a colour of its own: change a token
 * and every page follows.
 */

function classes(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ');
}

export interface IconProps {
  name: IconName;
  /** The length of its side, in pixels. */
  size?: number;
}

/** An icon, in the colour of the text around it. It says nothing by itself: what it stands for is said beside it. */
export function Icon({ name, size = 20 }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * - `primary`: the one thing to do on a screen;
   * - `danger`: what cannot be undone;
   * - `quiet`: something to the side, with no edge;
   * - left out: everything else.
   */
  variant?: 'primary' | 'danger' | 'quiet';
  size?: 'small';
  /** As wide as what it is in. */
  wide?: boolean;
  /** An icon before the words. */
  icon?: IconName;
}

/** A button with words on it. It does not submit a form unless told to. */
export function Button({
  variant,
  size,
  wide,
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes(
        'button',
        variant && `button-${variant}`,
        size && `button-${size}`,
        wide && 'button-wide',
        icon && 'button-with-icon',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'small' ? 16 : 18} /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  icon: IconName;
  /** What it does, for those who cannot see the icon and those who wonder what it is. */
  label: string;
  /** Whether what it switches is on, for a button that switches something. */
  pressed?: boolean;
}

/** A button that is only an icon. It always says what it does. */
export function IconButton({
  icon,
  label,
  pressed,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={classes('icon-button', className)}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

/** How many colours an avatar may have. */
const TONES = 6;

/** The same name always gets the same colour. */
export function toneOf(name: string): number {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % TONES;
}

export interface AvatarProps {
  /** Whose it is: a name, or failing that an address. */
  name: string;
  size?: 'small' | 'large';
}

/** Who something is from, at a glance: their initial on a colour of their own. The name is said beside it. */
export function Avatar({ name, size }: AvatarProps) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span
      className={classes(
        'avatar',
        size && `avatar-${size}`,
        `avatar-tone-${toneOf(name)}`,
      )}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /** `accent` for a label someone gave; `warning` and `danger` for a state that needs noticing. */
  tone?: 'accent' | 'warning' | 'danger';
}

/** A word or two about the thing beside it: a label, a state. */
export function Tag({ tone, className, ...rest }: TagProps) {
  return (
    <span
      className={classes('tag', tone && `tag-${tone}`, className)}
      {...rest}
    />
  );
}

export interface NoticeProps {
  /** `error` is announced at once; the others when the reader gets there. */
  tone?: 'error' | 'success' | 'warning';
  children: ReactNode;
}

/** Something the person should know, where it concerns them. */
export function Notice({ tone, children }: NoticeProps) {
  return (
    <div
      className={classes('notice', tone && `notice-${tone}`)}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

/** Says something to those who cannot see, where the page shows it some other way. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="visually-hidden">{children}</span>;
}

/** What is shown and what was chosen, kept in step with the theme. */
export function useTheme(theme: Theme) {
  const shown = useSyncExternalStore(theme.subscribe, () => theme.shown);
  const choice = useSyncExternalStore(theme.subscribe, () => theme.choice);
  return { shown, choice };
}

/** Switches between light and dark. It says what pressing it does. */
export function ThemeSwitch({ theme }: { theme: Theme }) {
  const { shown } = useTheme(theme);
  return (
    <IconButton
      icon={shown === 'dark' ? 'sun' : 'moon'}
      label={
        shown === 'dark'
          ? 'Switch to the light theme'
          : 'Switch to the dark theme'
      }
      onClick={() => theme.toggle()}
    />
  );
}
