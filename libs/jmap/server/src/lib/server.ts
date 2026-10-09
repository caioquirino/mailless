import type { CoreCapability } from '@mailless/jmap-core';
import {
  applySchedulingMessage,
  calendarsModule,
  nextCalendarAlert,
  takeCalendarAlerts,
  type CalendarAlert,
} from '@mailless/jmap-calendars';
import { contactsModule } from '@mailless/jmap-contacts';
import {
  createJmapEngine,
  type AuthContext,
  type JmapEngine,
  type JmapEngineOptions,
  type StorageAdapter,
} from '@mailless/jmap-engine';
import {
  blockedSendersModule,
  pictureSendersModule,
  calendarParts,
  importMessage,
  mailModule,
  recordDelivery,
  sendScheduled,
  type DeliveryUpdate,
  type ImportedEmail,
  type ImportOptions,
  type MailModuleOptions,
  type ScheduledSendOutcome,
  tagsModule,
} from '@mailless/jmap-mail';
import { sharingModule } from '@mailless/jmap-sharing';
import { schedulingMail } from './scheduling-mail.js';

/*
 * A JMAP server with everything this project offers: mail, contacts and
 * sharing on one engine. A server that wants less, or something of its own,
 * is put together from the same parts: see `createJmapEngine` and the
 * modules.
 */

export interface JmapServerOptions
  extends Omit<JmapEngineOptions, 'modules'>, MailModuleOptions {
  storage: StorageAdapter;
  limits?: Partial<CoreCapability>;
  /**
   * Told when the people on an event could not be told of it, or word from
   * someone else's calendar could not be taken in. Neither undoes what was
   * asked for: the event is kept, the message delivered.
   */
  onSchedulingError?: (error: unknown) => void;
}

export interface JmapServer extends Omit<JmapEngine, 'contextFor'> {
  /**
   * Parses a raw message, stores it and files it. This is how mail that did
   * not come through JMAP (inbound delivery) enters an account.
   */
  importMessage(
    auth: AuthContext,
    raw: Uint8Array,
    options: ImportOptions,
  ): Promise<ImportedEmail>;
  /**
   * Records what became of a sent message for some of its recipients, as
   * learned from the transport later (delivered, bounced, delayed). Returns
   * false when the submission does not exist.
   */
  recordDelivery(
    auth: AuthContext,
    submissionId: string,
    updates: Record<string, DeliveryUpdate>,
  ): Promise<boolean>;
  /**
   * Sends a message that was being held, now that its time has come. Called
   * by whatever the `scheduler` option arranged. Calling it twice, or for a
   * message that was cancelled, does nothing. Throws when sending failed in a
   * way worth trying again.
   */
  sendScheduled(
    auth: AuthContext,
    submissionId: string,
  ): Promise<ScheduledSendOutcome>;
  /**
   * The calendar reminders of an account that have come due and were not
   * told of yet, and when to ask next. Asking marks them as told: it is for
   * whoever tells the account's devices, at the moment it does.
   */
  takeCalendarAlerts(
    auth: AuthContext,
    now?: Date,
  ): Promise<{ due: CalendarAlert[]; next: Date | null }>;
  /** When an account next has a reminder due, without marking anything. Null with no events. */
  nextCalendarAlert(auth: AuthContext, now?: Date): Promise<Date | null>;
}

export function createJmapServer(options: JmapServerOptions): JmapServer {
  const {
    transport,
    quota,
    subscribeNewMailboxes,
    threadsRequireSameSubject,
    scheduler,
    maxDelayedSend,
    maxSizeBlob,
    identities,
    onAutoReply,
    onSchedulingError,
    ...engineOptions
  } = options;
  const mail: MailModuleOptions = {
    ...(transport ? { transport } : {}),
    ...(quota ? { quota } : {}),
    ...(subscribeNewMailboxes === undefined ? {} : { subscribeNewMailboxes }),
    ...(threadsRequireSameSubject === undefined
      ? {}
      : { threadsRequireSameSubject }),
    ...(scheduler ? { scheduler } : {}),
    ...(maxDelayedSend === undefined ? {} : { maxDelayedSend }),
    ...(maxSizeBlob === undefined ? {} : { maxSizeBlob }),
    ...(identities ? { identities } : {}),
    ...(onAutoReply ? { onAutoReply } : {}),
  };
  const { contextFor, ...engine } = createJmapEngine({
    ...engineOptions,
    modules: [
      mailModule(mail),
      tagsModule(),
      blockedSendersModule(),
      pictureSendersModule(),
      sharingModule(),
      contactsModule(),
      calendarsModule(
        // The people on an event are told of it where there is a way to send mail.
        transport
          ? {
              scheduling: {
                addresses: async (ctx) =>
                  (await ctx.mail.identities()).map((identity) => ({
                    email: identity.email,
                    name: identity.name,
                  })),
                send: async (ctx, message) => {
                  await transport.send(schedulingMail(message), {
                    mailFrom: message.from.email,
                    rcptTo: message.to,
                  });
                },
              },
              ...(onSchedulingError ? { onSchedulingError } : {}),
            }
          : {},
      ),
    ],
  });

  return {
    ...engine,
    importMessage: async (auth, raw, importOptions) => {
      const ctx = contextFor(auth);
      const imported = await importMessage(ctx, raw, importOptions);
      // Mail from outside may be word from someone else's calendar: an answer
      // to an invitation, or an event that is off. It is taken in; the
      // message is delivered whether or not that worked.
      if (importOptions.delivery) {
        try {
          const { from, calendars } = await calendarParts(raw);
          for (const calendar of from ? calendars : []) {
            await applySchedulingMessage(ctx, calendar, from as string);
          }
        } catch (error) {
          onSchedulingError?.(error);
        }
      }
      return imported;
    },
    recordDelivery: (auth, submissionId, updates) =>
      recordDelivery(contextFor(auth), submissionId, updates),
    sendScheduled: (auth, submissionId) =>
      sendScheduled(contextFor(auth), submissionId),
    takeCalendarAlerts: (auth, now = new Date()) =>
      takeCalendarAlerts(contextFor(auth), now),
    nextCalendarAlert: (auth, now = new Date()) =>
      nextCalendarAlert(contextFor(auth), now),
  };
}
