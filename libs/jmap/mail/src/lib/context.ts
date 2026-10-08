import type { Identity } from '@mailless/jmap-core';
import type { MailTransport, SendScheduler } from './transport.js';

/** An identity together with the further addresses it may send as, which clients never see. */
export type ResolvedIdentity = Identity & { allowedFrom: string[] };

/** What the mail methods need besides what every method has. */
export interface MailContext {
  /** Present when the server can send mail. */
  transport?: MailTransport;
  /** Present when messages can be held and sent later. */
  scheduler?: SendScheduler;
  /** The longest a message may be held, in seconds; 0 when it cannot be. */
  maxDelayedSend: number;
  /** What `isSubscribed` is on a mailbox created without saying. */
  subscribeByDefault: boolean;
  /** Whether a reply must keep the subject to join the thread of what it answers. */
  threadsRequireSameSubject: boolean;
  /** The most octets of mail the account may hold, or null for no limit. */
  quotaOctets: number | null;
  /** The addresses the caller may send from. */
  identities(): Promise<ResolvedIdentity[]>;
  /** Told what became of the vacation response for a delivered message. */
  onAutoReply?: (outcome: string, error?: unknown) => void;
}

declare module '@mailless/jmap-engine' {
  interface MethodContext {
    /** Set by the mail module on every context. */
    mail: MailContext;
  }
}
