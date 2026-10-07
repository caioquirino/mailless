import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import {
  MailRejectedError,
  type MailEnvelope,
  type MailTransport,
} from '@mailless/jmap-server';

export interface SesMailTransportOptions {
  client: SESv2Client;
  /** Configuration set to send through, for event publishing and suppression settings. */
  configurationSetName?: string;
}

/** SES errors that mean this message will never be accepted, rather than "try again later". */
const REJECTIONS = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
  'BadRequestException',
]);

/** Sends finished messages through Amazon SES. */
export class SesMailTransport implements MailTransport {
  private readonly client: SESv2Client;
  private readonly configurationSetName: string | undefined;

  constructor(options: SesMailTransportOptions) {
    this.client = options.client;
    this.configurationSetName = options.configurationSetName;
  }

  async send(message: Uint8Array, envelope: MailEnvelope): Promise<void> {
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: envelope.mailFrom,
          // With raw content, SES delivers to exactly these addresses, whatever the headers say.
          // That is what keeps Bcc recipients out of the message while still reaching them.
          Destination: { ToAddresses: envelope.rcptTo },
          Content: { Raw: { Data: message } },
          ...(this.configurationSetName
            ? { ConfigurationSetName: this.configurationSetName }
            : {}),
          // Tags come back on SES events, which is how a bounce is matched to what was sent.
          ...(envelope.tags && Object.keys(envelope.tags).length > 0
            ? {
                EmailTags: Object.entries(envelope.tags).map(
                  ([Name, Value]) => ({
                    Name,
                    Value,
                  }),
                ),
              }
            : {}),
        }),
      );
    } catch (error) {
      const failure = error as { name?: string; message?: string };
      if (REJECTIONS.has(failure.name ?? '')) {
        throw new MailRejectedError(
          failure.message ?? 'SES rejected the message',
        );
      }
      throw error;
    }
  }
}
