export interface MailEnvelope {
  mailFrom: string;
  rcptTo: string[];
  /**
   * Labels to attach to the message where the transport supports it, so that
   * later delivery events can be matched to what was sent. Keys and values
   * use only letters, digits, "-" and "_".
   */
  tags?: Record<string, string>;
}

/**
 * Hands a finished RFC 5322 message to something that delivers it: SES, an
 * SMTP relay, or a test double.
 */
export interface MailTransport {
  /**
   * Resolves once the message is accepted for delivery. Throw
   * MailRejectedError when the message itself was refused; any other error is
   * treated as a failure of the service.
   */
  send(
    message: Uint8Array,
    envelope: MailEnvelope,
  ): Promise<void | MailReceipt>;
}

export interface MailReceipt {
  /**
   * Message ids, without angle brackets, that the transport gave the message
   * in place of its own. Some services rewrite the Message-ID header; replies
   * then refer to the new id, and knowing it keeps them in the same thread.
   */
  messageIds?: string[];
}

/** The transport refused this message, for example an unverified sender or a blocked recipient. */
export class MailRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailRejectedError';
  }
}

/** A message held for later, to be sent by calling `sendScheduled` at `sendAt`. */
export interface ScheduledSend {
  accountId: string;
  submissionId: string;
  sendAt: Date;
}

/**
 * Wakes the server up when a held message is due: a timer in a long-running
 * process, a scheduling service where there is none. With one configured,
 * clients may ask for a message to be sent later, and cancel it until then.
 */
export interface SendScheduler {
  /**
   * Arranges for `sendScheduled(auth, submissionId)` to be called at
   * `sendAt`. A call that comes more than once, or late, is harmless.
   */
  schedule(job: ScheduledSend): Promise<void>;
  /**
   * Told when a held message was cancelled, so that the wake-up can be
   * dropped. Optional: waking up for a cancelled message does nothing.
   */
  cancel?(job: Omit<ScheduledSend, 'sendAt'>): Promise<void>;
}
