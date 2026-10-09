import { CAPABILITY_CALENDARS } from '@mailless/jmap-core';
import type { JmapModule } from '@mailless/jmap-engine';
import type { Scheduling } from './scheduling.js';
import {
  CALENDAR,
  CALENDAR_EVENT,
  calendarMethods,
  prepareCalendars,
  provisionCalendars,
} from './calendars.js';

export interface CalendarsModuleOptions {
  /**
   * How the people on an event are told of it, by mail. Without it nobody
   * is: `sendSchedulingMessages` is taken and does nothing.
   */
  scheduling?: Scheduling;
  onSchedulingError?: (error: unknown) => void;
}

/** Calendars for a JMAP server: calendars, and the events in them (JSCalendar, RFC 8984). */
export function calendarsModule(
  options: CalendarsModuleOptions = {},
): JmapModule {
  return {
    name: 'calendars',
    extendContext(ctx) {
      ctx.calendars = {
        ...(options.scheduling ? { scheduling: options.scheduling } : {}),
        ...(options.onSchedulingError
          ? { onSchedulingError: options.onSchedulingError }
          : {}),
      };
    },
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
    // CalendarAlert is not data: a push of it is a reminder that has come due.
    pushedTypes: [CALENDAR, CALENDAR_EVENT, 'CalendarAlert'],
  };
}
