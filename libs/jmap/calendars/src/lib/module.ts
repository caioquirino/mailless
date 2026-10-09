import { CAPABILITY_CALENDARS } from '@mailless/jmap-core';
import type { JmapModule } from '@mailless/jmap-engine';
import {
  CALENDAR,
  CALENDAR_EVENT,
  calendarMethods,
  prepareCalendars,
  provisionCalendars,
} from './calendars.js';

/** Calendars for a JMAP server: calendars, and the events in them (JSCalendar, RFC 8984). */
export function calendarsModule(): JmapModule {
  return {
    name: 'calendars',
    capabilities: { [CAPABILITY_CALENDARS]: {} },
    accountCapabilities: (access) => ({
      [CAPABILITY_CALENDARS]: {
        maxCalendarsPerEvent: null,
        mayCreateCalendar: !access.isReadOnly,
      },
    }),
    methods: Object.fromEntries(
      Object.entries(calendarMethods).map(([name, handler]) => [
        name,
        { capability: CAPABILITY_CALENDARS, handler },
      ]),
    ),
    provisionAccount: provisionCalendars,
    // An account older than its calendar gets one the first time it is used.
    prepareAccount: prepareCalendars,
    pushedTypes: [CALENDAR, CALENDAR_EVENT],
  };
}
