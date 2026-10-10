/*
 * Events as files and messages carry them, by themselves: for a program
 * that reads and writes .ics and keeps no calendar of its own.
 */
export {
  fromICalendar,
  toICalendar,
  toICalendarFile,
  type Method,
} from './lib/icalendar.js';
