import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { MailRejectedError } from '@mailless/jmap-server';
import { SesMailTransport } from './ses-mail-transport.js';

const message = new TextEncoder().encode('From: me@example.com\r\n\r\nhi\r\n');
const envelope = {
  mailFrom: 'me@example.com',
  rcptTo: ['a@example.org', 'b@example.org'],
};

function fakeClient(
  failure?: { name: string; message: string },
  region = 'eu-central-1',
) {
  const sent: Array<{ name: string; input: unknown }> = [];
  const client = {
    config: { region: async () => region },
    async send(command: { constructor: { name: string }; input: unknown }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (failure)
        throw Object.assign(new Error(failure.message), { name: failure.name });
      return { MessageId: '0107abc-000000' };
    },
  } as unknown as SESv2Client;
  return { client, sent };
}

describe('SesMailTransport', () => {
  it('sends the raw message to exactly the envelope recipients', async () => {
    const { client, sent } = fakeClient();
    await new SesMailTransport({ client }).send(message, envelope);
    expect(sent).toEqual([
      {
        name: 'SendEmailCommand',
        input: {
          FromEmailAddress: 'me@example.com',
          Destination: { ToAddresses: ['a@example.org', 'b@example.org'] },
          Content: { Raw: { Data: message } },
        },
      },
    ]);
  });

  it('reports the Message-ID that SES substitutes, which differs by region', async () => {
    const frankfurt = fakeClient();
    expect(
      await new SesMailTransport({ client: frankfurt.client }).send(
        message,
        envelope,
      ),
    ).toEqual({
      messageIds: ['0107abc-000000@eu-central-1.amazonses.com'],
    });
    const virginia = fakeClient(undefined, 'us-east-1');
    expect(
      await new SesMailTransport({ client: virginia.client }).send(
        message,
        envelope,
      ),
    ).toEqual({
      messageIds: ['0107abc-000000@email.amazonses.com'],
    });
  });

  it('attaches the envelope tags to the message', async () => {
    const { client, sent } = fakeClient();
    await new SesMailTransport({ client }).send(message, {
      ...envelope,
      tags: { account: 'me', submission: 'es123' },
    });
    expect(sent[0]?.input).toMatchObject({
      EmailTags: [
        { Name: 'account', Value: 'me' },
        { Name: 'submission', Value: 'es123' },
      ],
    });

    await new SesMailTransport({ client }).send(message, {
      ...envelope,
      tags: {},
    });
    expect(sent[1]?.input).not.toHaveProperty('EmailTags');
  });

  it('uses a configuration set when given one', async () => {
    const { client, sent } = fakeClient();
    await new SesMailTransport({ client, configurationSetName: 'mail' }).send(
      message,
      envelope,
    );
    expect(sent[0]?.input).toMatchObject({ ConfigurationSetName: 'mail' });
  });

  it.each([
    'MessageRejected',
    'MailFromDomainNotVerifiedException',
    'AccountSuspendedException',
    'SendingPausedException',
    'BadRequestException',
  ])('reports %s as a rejection of the message', async (name) => {
    const { client } = fakeClient({
      name,
      message: 'Email address is not verified.',
    });
    const attempt = new SesMailTransport({ client }).send(message, envelope);
    await expect(attempt).rejects.toBeInstanceOf(MailRejectedError);
    await expect(attempt).rejects.toThrow('Email address is not verified.');
  });

  it.each([
    'TooManyRequestsException',
    'LimitExceededException',
    'TimeoutError',
  ])('passes %s through as a service failure', async (name) => {
    const { client } = fakeClient({ name, message: 'slow down' });
    const attempt = new SesMailTransport({ client }).send(message, envelope);
    await expect(attempt).rejects.not.toBeInstanceOf(MailRejectedError);
    await expect(attempt).rejects.toMatchObject({ name });
  });
});
