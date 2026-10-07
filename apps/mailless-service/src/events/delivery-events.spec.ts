import {
  handleDeliveryEvent,
  type SesSendingEvent,
} from './delivery-events.js';

function setup(found = true) {
  const recorded: Array<{
    accountId: string;
    submissionId: string;
    updates: unknown;
  }> = [];
  const logs: Record<string, unknown>[] = [];
  const run = (event: SesSendingEvent) =>
    handleDeliveryEvent(event, {
      jmap: {
        recordDelivery: async (auth, submissionId, updates) => {
          recorded.push({ accountId: auth.accountId, submissionId, updates });
          return found;
        },
      },
      log: (entry) => logs.push(entry),
    });
  return { run, recorded, logs };
}

const mail = {
  messageId: 'ses-1',
  destination: ['bob@example.org', 'carol@example.org'],
  tags: {
    account: ['me'],
    submission: ['es123'],
    'ses:configuration-set': ['mailless'],
  },
};

describe('handleDeliveryEvent', () => {
  it('records a delivery', async () => {
    const { run, recorded } = setup();
    expect(
      await run({
        eventType: 'Delivery',
        mail,
        delivery: {
          recipients: ['bob@example.org'],
          smtpResponse: '250 2.0.0 OK  abc - gsmtp',
        },
      }),
    ).toBe('recorded');
    expect(recorded).toEqual([
      {
        accountId: 'me',
        submissionId: 'es123',
        updates: {
          'bob@example.org': {
            delivered: 'yes',
            smtpReply: '250 2.0.0 OK abc - gsmtp',
          },
        },
      },
    ]);
  });

  it("records a bounce with the remote server's explanation, kept short and on one line", async () => {
    const { run, recorded } = setup();
    await run({
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          {
            emailAddress: 'bob@example.org',
            status: '5.1.1',
            diagnosticCode: `smtp; 550 5.1.1 user unknown\r\n${'x'.repeat(500)}`,
          },
          { emailAddress: 'carol@example.org' },
        ],
      },
    });
    const updates = recorded[0]?.updates as Record<
      string,
      { delivered: string; smtpReply: string }
    >;
    expect(updates['bob@example.org']?.delivered).toBe('no');
    expect(
      updates['bob@example.org']?.smtpReply.startsWith(
        '5.1.1 smtp; 550 5.1.1 user unknown x',
      ),
    ).toBe(true);
    expect(updates['bob@example.org']?.smtpReply).toHaveLength(300);
    expect(updates['carol@example.org']).toEqual({
      delivered: 'no',
      smtpReply: 'Permanent bounce',
    });
  });

  it('records delays as still queued and rejections as failed for everyone', async () => {
    const { run, recorded } = setup();
    await run({
      eventType: 'DeliveryDelay',
      mail,
      deliveryDelay: {
        delayType: 'MailboxFull',
        delayedRecipients: [{ emailAddress: 'bob@example.org' }],
      },
    });
    await run({ eventType: 'Reject', mail, reject: { reason: 'Bad content' } });
    expect(recorded.map((entry) => entry.updates)).toEqual([
      {
        'bob@example.org': {
          delivered: 'queued',
          smtpReply: 'Delayed: MailboxFull',
        },
      },
      {
        'bob@example.org': { delivered: 'no', smtpReply: 'Bad content' },
        'carol@example.org': { delivered: 'no', smtpReply: 'Bad content' },
      },
    ]);
  });

  it('notes complaints without changing delivery status', async () => {
    const { run, recorded, logs } = setup();
    expect(
      await run({
        eventType: 'Complaint',
        mail,
        complaint: {
          complaintFeedbackType: 'abuse',
          complainedRecipients: [{ emailAddress: 'bob@example.org' }],
        },
      }),
    ).toBe('noted');
    expect(recorded).toEqual([]);
    expect(logs[0]).toMatchObject({
      outcome: 'noted',
      complaintType: 'abuse',
      recipients: 1,
    });
  });

  it('skips events it cannot attribute or does not track', async () => {
    const { run, recorded } = setup();
    const delivery = { recipients: ['bob@example.org'] };
    expect(await run({ eventType: 'Send', mail })).toBe('ignored');
    expect(await run({ eventType: 'Open', mail })).toBe('ignored');
    expect(
      await run({ eventType: 'Delivery', mail: { messageId: 'x' }, delivery }),
    ).toBe('untracked');
    expect(
      await run({
        eventType: 'Delivery',
        mail: {
          ...mail,
          tags: { account: ['../other'], submission: ['es123'] },
        },
        delivery,
      }),
    ).toBe('untracked');
    expect(await run({})).toBe('ignored');
    expect(recorded).toEqual([]);
  });

  it('reports a submission that no longer exists', async () => {
    const { run } = setup(false);
    expect(
      await run({
        eventType: 'Delivery',
        mail,
        delivery: { recipients: ['bob@example.org'] },
      }),
    ).toBe('unknown-submission');
  });

  it('never logs addresses or diagnostic text', async () => {
    const { run, logs } = setup();
    await run({
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [
          {
            emailAddress: 'bob@example.org',
            diagnosticCode: 'quoted secret subject line',
          },
        ],
      },
    });
    const text = JSON.stringify(logs);
    expect(text).not.toContain('bob@example.org');
    expect(text).not.toContain('secret');
    expect(logs[0]).toEqual({
      eventType: 'Bounce',
      messageId: 'ses-1',
      submissionId: 'es123',
      bounceType: 'Permanent',
      bounceSubType: undefined,
      recipients: 1,
      outcome: 'recorded',
    });
  });
});
