import {
  CAPABILITY_CALENDAR_PROPOSALS,
  CAPABILITY_CALENDARS,
} from '@mailless/jmap-core';
import type { JmapModule } from '@mailless/jmap-engine';
import type { Scheduling } from './scheduling.js';
import {
  CALENDAR,
  CALENDAR_EVENT,
  calendarMethods,
  prepareCalendars,
  proposalMethods,
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
    capabilities: {
      [CAPABILITY_CALENDARS]: {},
      // Suggesting another time is offered where there is a way to send mail.
      ...(options.scheduling ? { [CAPABILITY_CALENDAR_PROPOSALS]: {} } : {}),
    },
    accountCapabilities: (access) => ({
      [CAPABILITY_CALENDARS]: {
        maxCalendarsPerEvent: null,
        mayCreateCalendar: !access.isReadOnly,
      },
      ...(options.scheduling ? { [CAPABILITY_CALENDAR_PROPOSALS]: {} } : {}),
    }),
    methods: Object.fromEntries([
      ...Object.entries(calendarMethods).map(([name, handler]) => [
        name,
        { capability: CAPABILITY_CALENDARS, handler },
      ]),
      ...(options.scheduling
        ? Object.entries(proposalMethods).map(([name, handler]) => [
            name,
            { capability: CAPABILITY_CALENDAR_PROPOSALS, handler },
          ])
        : []),
    ]),
    provisionAccount: provisionCalendars,
    // An account older than its calendar gets one the first time it is used.
    prepareAccount: prepareCalendars,
    // CalendarAlert is not data: a push of it is a reminder that has come due.
    pushedTypes: [CALENDAR, CALENDAR_EVENT, 'CalendarAlert'],
  };
}
