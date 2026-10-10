import {
  CAPABILITY_CALENDAR_PROPOSALS,
  CAPABILITY_CALENDAR_SUBSCRIPTIONS,
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
  subscriptionMethods,
} from './calendars.js';

export interface CalendarsModuleOptions {
  /**
   * How the people on an event are told of it, by mail. Without it nobody
   * is: `sendSchedulingMessages` is taken and does nothing.
   */
  scheduling?: Scheduling;
  onSchedulingError?: (error: unknown) => void;
  /**
   * Fetches a calendar kept somewhere else, from the address it is published
   * at. Without it no such calendar can be added. Whoever gives it decides
   * which addresses it goes to: the address comes from the account's owner.
   */
  fetchCalendar?: (url: string) => Promise<string>;
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
        ...(options.fetchCalendar
          ? { fetchCalendar: options.fetchCalendar }
          : {}),
      };
    },
    capabilities: {
      [CAPABILITY_CALENDARS]: {},
      // Suggesting another time is offered where there is a way to send mail.
      ...(options.scheduling ? { [CAPABILITY_CALENDAR_PROPOSALS]: {} } : {}),
      ...(options.fetchCalendar
        ? { [CAPABILITY_CALENDAR_SUBSCRIPTIONS]: {} }
        : {}),
    },
    accountCapabilities: (access) => ({
      [CAPABILITY_CALENDARS]: {
        maxCalendarsPerEvent: null,
        mayCreateCalendar: !access.isReadOnly,
      },
      ...(options.scheduling ? { [CAPABILITY_CALENDAR_PROPOSALS]: {} } : {}),
      ...(options.fetchCalendar
        ? { [CAPABILITY_CALENDAR_SUBSCRIPTIONS]: {} }
        : {}),
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
      ...(options.fetchCalendar
        ? Object.entries(subscriptionMethods).map(([name, handler]) => [
            name,
            { capability: CAPABILITY_CALENDAR_SUBSCRIPTIONS, handler },
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
