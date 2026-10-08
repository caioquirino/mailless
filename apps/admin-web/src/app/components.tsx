import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { AccountStatus, MailUsage } from '@mailless/admin-client';
import { failureMessage } from '../lib/api';

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** A date as people read it; `fallback` when there is none. */
export function formatDate(value: string | null, fallback = 'Never'): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : dateTime.format(date);
}

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'];

/** A size as people read it: "1.2 GB". */
export function formatSize(octets: number): string {
  let value = octets;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown =
    unit === 0 || value >= 100
      ? Math.round(value).toString()
      : value.toFixed(1).replace(/\.0$/, '');
  return `${shown} ${UNITS[unit]}`;
}

/** How full a mailbox is in words, with the share used when there is a limit. */
export function usageText(usage: MailUsage): string {
  if (usage.usedOctets === null) {
    return usage.limitOctets === null
      ? 'Not counted yet'
      : `Not counted yet · ${formatSize(usage.limitOctets)} allowed`;
  }
  if (usage.limitOctets === null) {
    return `${formatSize(usage.usedOctets)} · no limit`;
  }
  const share = Math.round((usage.usedOctets / usage.limitOctets) * 100);
  return `${formatSize(usage.usedOctets)} of ${formatSize(usage.limitOctets)} (${share}%)`;
}

/**
 * How full a mailbox is: the numbers, and a bar when there is a limit to
 * measure against. `compact` leaves the explanation out, for a table.
 */
export function Usage({
  usage,
  compact = false,
}: {
  usage: MailUsage;
  compact?: boolean;
}) {
  const { usedOctets, limitOctets } = usage;
  const measured = usedOctets !== null && limitOctets !== null;
  return (
    <div className={compact ? 'usage usage-compact' : 'usage'}>
      {measured ? (
        <meter
          className="usage-meter"
          min={0}
          max={limitOctets}
          // From here on the bar warns, and from here it is nearly full.
          high={limitOctets * 0.8}
          optimum={0}
          low={limitOctets * 0.6}
          value={Math.min(usedOctets, limitOctets)}
          aria-label="Mailbox space used"
        />
      ) : null}
      <span className={usedOctets === null ? 'muted' : undefined}>
        {usageText(usage)}
      </span>
      {!compact && usedOctets === null ? (
        <p className="muted usage-note">
          A mailbox is counted the first time it is used: when a mail app next
          connects to it, or mail arrives.
        </p>
      ) : null}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {description ? <p className="muted">{description}</p> : null}
      {children}
    </section>
  );
}

/**
 * What came of an action. Always in the page, so that a screen reader is told
 * when it changes.
 */
export function Notice({
  error,
  success,
}: {
  error?: unknown;
  success?: string | null | undefined;
}) {
  return (
    <div aria-live="polite" className="notice-slot">
      {error ? (
        <p className="notice notice-error" role="alert">
          {failureMessage(error)}
        </p>
      ) : success ? (
        <p className="notice notice-success">{success}</p>
      ) : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" role="status">
      Loading {what}…
    </p>
  );
}

/** A list could not be loaded: says so, and offers to try again. */
export function LoadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry(): void;
}) {
  return (
    <div className="notice notice-error" role="alert">
      <p>{failureMessage(error)}</p>
      <button type="button" className="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

const STATUS_TEXT: Record<AccountStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  deleting: 'Closed',
};

export function StatusBadge({ status }: { status: AccountStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_TEXT[status]}</span>;
}

/**
 * A button that asks before it acts. With `typeToConfirm`, that text has to
 * be typed first: for what cannot be undone.
 */
export function ConfirmButton({
  label,
  title,
  children,
  confirmLabel,
  danger = false,
  disabled = false,
  typeToConfirm,
  onConfirm,
}: {
  label: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  disabled?: boolean;
  typeToConfirm?: string;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const inputId = useId();

  // The dialog is in the page only while it is open, and opened as a modal when it arrives.
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    close();
    onConfirm();
  };
  const ready = typeToConfirm === undefined || typed === typeToConfirm;

  return (
    <>
      <button
        type="button"
        className={danger ? 'button button-danger-quiet' : 'button'}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className="dialog"
          aria-labelledby={titleId}
          onClose={close}
        >
          <form onSubmit={submit}>
            <h2 id={titleId}>{title}</h2>
            <div className="dialog-body">{children}</div>
            {typeToConfirm !== undefined ? (
              <div className="field">
                <label htmlFor={inputId}>
                  Type <strong>{typeToConfirm}</strong> to confirm
                </label>
                <input
                  id={inputId}
                  value={typed}
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                />
              </div>
            ) : null}
            <div className="actions">
              <button type="button" className="button" onClick={close}>
                Cancel
              </button>
              <button
                type="submit"
                className={
                  danger ? 'button button-danger' : 'button button-primary'
                }
                disabled={!ready}
              >
                {confirmLabel}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  );
}
