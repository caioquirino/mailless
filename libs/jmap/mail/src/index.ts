export {
  mailModule,
  type IdentityInput,
  type MailModuleOptions,
} from './lib/module.js';
export { type MailContext, type ResolvedIdentity } from './lib/context.js';
export {
  importMessage,
  type ImportedEmail,
  type ImportOptions,
} from './lib/email.js';
export {
  recordDelivery,
  sendScheduled,
  type DeliveryUpdate,
  type ScheduledSendOutcome,
} from './lib/submission.js';
export {
  MailRejectedError,
  type MailEnvelope,
  type MailReceipt,
  type MailTransport,
  type ScheduledSend,
  type SendScheduler,
} from './lib/transport.js';
// How full a mailbox is, for something that reports on accounts without reading their mail.
export { storedUsage } from './lib/quota.js';
export { tagsModule } from './lib/tag.js';
// What a message says of a calendar, for a server that keeps one too.
export { calendarParts } from './lib/mime.js';
export { blockedSendersModule } from './lib/blocked.js';
