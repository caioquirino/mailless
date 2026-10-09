import { Link, useLocation } from 'react-router';
import { Icon, type IconName } from '@mailless/ui';

/**
 * The parts of mailless: mail, contacts, and what is on its way. At the foot
 * of the menu on a wide screen, side by side, or one above the other when the
 * menu is folded; along the bottom of the page on a phone.
 */
export function Rail() {
  const contacts = useLocation().pathname.startsWith('/contacts');
  const item = (
    to: string,
    icon: IconName,
    label: string,
    current: boolean,
  ) => (
    <Link
      to={to}
      className={`rail-item${current ? ' rail-current' : ''}`}
      title={label}
      {...(current ? { 'aria-current': 'page' as const } : {})}
    >
      <span className="rail-icon">
        <Icon name={icon} />
      </span>
      <span className="rail-label">{label}</span>
    </Link>
  );
  return (
    <nav className="rail" aria-label="Sections">
      {item('/', 'mail', 'Mail', !contacts)}
      <span
        className="rail-item rail-soon"
        aria-disabled="true"
        title="Calendar: not here yet"
      >
        <span className="rail-icon">
          <Icon name="calendar" />
        </span>
        <span className="rail-label">Calendar</span>
      </span>
      {item('/contacts', 'contacts', 'Contacts', contacts)}
    </nav>
  );
}
