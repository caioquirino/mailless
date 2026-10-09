import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button, Icon } from '@mailless/ui';
import { Face } from './face';
import { formatSize } from '../lib/format';
import type { Usage } from '../lib/mail';
import { useMail, useServices, useSynced } from './services';

/**
 * Who is signed in, behind their picture in the top bar: their name and
 * address, how full their mailbox is, where their password is, and the way
 * out.
 */
export function ProfileMenu() {
  const { config, session } = useServices();
  const { store, notifications } = useMail();
  useSynced(store.identities);
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [leaving, setLeaving] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const identity = store.identities.values()[0];
  const name = identity?.name || identity?.email || 'Your account';

  // Asked for each time it is opened: it is a number that goes out of date.
  useEffect(() => {
    if (!open) return;
    let current = true;
    void store.usage().then(
      (found) => current && setUsage(found),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open, store]);

  // Pressing Escape, or anywhere else, puts it away.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const signOut = () => {
    setLeaving(true);
    // Mail is not announced to a browser nobody is signed in to. Not waited for long: signing out comes first.
    void Promise.race([
      notifications.disable().catch(() => undefined),
      new Promise((resolve) => window.setTimeout(resolve, 3000)),
    ]).then(() => session.signOut());
  };

  const share =
    usage && usage.limit !== null && usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : null;

  return (
    <div className="profile" ref={menu}>
      <button
        type="button"
        className="profile-button"
        aria-label={`Account: ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Face name={name} email={identity?.email} />
      </button>
      {open ? (
        <div className="profile-card" role="dialog" aria-label="Account">
          <div className="profile-who">
            <Face name={name} email={identity?.email} size="large" />
            <div className="profile-names">
              <strong>{name}</strong>
              {identity && identity.email !== name ? (
                <span className="muted">{identity.email}</span>
              ) : null}
            </div>
          </div>
          {usage ? (
            <div className="profile-usage">
              {share !== null ? (
                <div
                  className="meter"
                  role="meter"
                  aria-label="How full the mailbox is"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={share}
                >
                  <span
                    className={`meter-fill meter-${Math.ceil(share / 5) * 5}${
                      share >= 90 ? ' meter-full' : ''
                    }`}
                  />
                </div>
              ) : null}
              <span className="muted small">
                {usage.limit !== null
                  ? `${formatSize(usage.used)} of ${formatSize(usage.limit)} used`
                  : `${formatSize(usage.used)} used`}
              </span>
            </div>
          ) : null}
          <div className="profile-links">
            {/* On a phone the bar at the top has no room for it: it is here instead. */}
            <Link
              className="profile-link profile-settings"
              to="/settings"
              onClick={() => setOpen(false)}
            >
              <Icon name="settings" />
              Settings
            </Link>
            {config.accountUrl ? (
              <a className="profile-link" href={config.accountUrl}>
                <Icon name="account" />
                Password, passkeys and app passwords
              </a>
            ) : null}
            <Button
              className="profile-link"
              variant="quiet"
              icon="sign-out"
              disabled={leaving}
              onClick={signOut}
            >
              Sign out
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
