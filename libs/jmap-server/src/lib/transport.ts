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
