export interface MailEnvelope {
  mailFrom: string;
  rcptTo: string[];
}

/**
 * Hands a finished RFC 5322 message to something that delivers it: SES, an
 * SMTP relay, or a test double. Not used by any method yet; EmailSubmission
 * will be built on it.
 */
export interface MailTransport {
  send(message: Uint8Array, envelope: MailEnvelope): Promise<void>;
}
