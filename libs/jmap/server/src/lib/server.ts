import type { CoreCapability } from '@mailless/jmap-core';
import { contactsModule } from '@mailless/jmap-contacts';
import {
  createJmapEngine,
  type AuthContext,
  type JmapEngine,
  type JmapEngineOptions,
  type StorageAdapter,
} from '@mailless/jmap-engine';
import {
  importMessage,
  mailModule,
  recordDelivery,
  sendScheduled,
  type DeliveryUpdate,
  type ImportedEmail,
  type ImportOptions,
  type MailModuleOptions,
  type ScheduledSendOutcome,
} from '@mailless/jmap-mail';
import { sharingModule } from '@mailless/jmap-sharing';

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
}

export function createJmapServer(options: JmapServerOptions): JmapServer {
  const {
    transport,
    quota,
    subscribeNewMailboxes,
    threadsRequireSameSubject,
    scheduler,
    maxDelayedSend,
    identities,
    onAutoReply,
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
    ...(identities ? { identities } : {}),
    ...(onAutoReply ? { onAutoReply } : {}),
  };
  const { contextFor, ...engine } = createJmapEngine({
    ...engineOptions,
    modules: [mailModule(mail), sharingModule(), contactsModule()],
  });

  return {
    ...engine,
    importMessage: (auth, raw, importOptions) =>
      importMessage(contextFor(auth), raw, importOptions),
    recordDelivery: (auth, submissionId, updates) =>
      recordDelivery(contextFor(auth), submissionId, updates),
    sendScheduled: (auth, submissionId) =>
      sendScheduled(contextFor(auth), submissionId),
  };
}
