export { calendarsModule, type CalendarsModuleOptions } from './lib/module.js';
export { applySchedulingMessage } from './lib/calendars.js';
export { fromICalendar, toICalendar, type Method } from './lib/icalendar.js';
export type { Own, Scheduling, SchedulingMessage } from './lib/scheduling.js';
export {
  nextCalendarAlert,
  takeCalendarAlerts,
  type CalendarAlert,
} from './lib/alerts.js';
export { durationMillis, zonedToUtc } from './lib/time.js';
