import type { DeliveryUpdate, JmapServer } from '@mailless/jmap-server';

/** The parts of an SES event (as published to SNS) that are used here. */
export interface SesSendingEvent {
  eventType?: string;
  mail?: {
    messageId?: string;
    destination?: string[];
    tags?: Record<string, string[] | undefined>;
  };
  delivery?: { recipients?: string[]; smtpResponse?: string };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{
      emailAddress: string;
      status?: string;
      diagnosticCode?: string;
    }>;
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{ emailAddress: string }>;
  };
  deliveryDelay?: {
    delayType?: string;
    delayedRecipients?: Array<{
      emailAddress: string;
      status?: string;
      diagnosticCode?: string;
    }>;
  };
  reject?: { reason?: string };
}

export type DeliveryEventOutcome =
  'recorded' | 'noted' | 'untracked' | 'unknown-submission' | 'ignored';

export interface DeliveryEventDependencies {
  jmap: Pick<JmapServer, 'recordDelivery'>;
  log?(entry: Record<string, unknown>): void;
}

const ID = /^[A-Za-z0-9_-]{1,255}$/;

function reply(
  status: string | undefined,
  text: string | undefined,
  fallback: string,
): string {
  const combined = [status, text].filter(Boolean).join(' ').trim();
  // Diagnostic text comes from other mail servers; keep it short and on one line.
  return (combined || fallback).replace(/\s+/g, ' ').slice(0, 300);
}

function toUpdates(
  event: SesSendingEvent,
): Record<string, DeliveryUpdate> | null {
  switch (event.eventType) {
    case 'Delivery':
      return Object.fromEntries(
        (event.delivery?.recipients ?? []).map((recipient) => [
          recipient,
          {
            delivered: 'yes' as const,
            smtpReply: reply(
              undefined,
              event.delivery?.smtpResponse,
              '250 Delivered',
            ),
          },
        ]),
      );
    case 'Bounce':
      return Object.fromEntries(
        (event.bounce?.bouncedRecipients ?? []).map((recipient) => [
          recipient.emailAddress,
          {
            delivered: 'no' as const,
            smtpReply: reply(
              recipient.status,
              recipient.diagnosticCode,
              `${event.bounce?.bounceType ?? 'Unknown'} bounce`,
            ),
          },
        ]),
      );
    case 'DeliveryDelay':
      return Object.fromEntries(
        (event.deliveryDelay?.delayedRecipients ?? []).map((recipient) => [
          recipient.emailAddress,
          {
            delivered: 'queued' as const,
            smtpReply: reply(
              recipient.status,
              recipient.diagnosticCode,
              `Delayed: ${event.deliveryDelay?.delayType ?? 'unknown reason'}`,
            ),
          },
        ]),
      );
    case 'Reject':
      return Object.fromEntries(
        (event.mail?.destination ?? []).map((recipient) => [
          recipient,
          {
            delivered: 'no' as const,
            smtpReply: reply(
              undefined,
              event.reject?.reason,
              'Rejected by SES',
            ),
          },
        ]),
      );
    default:
      return null;
  }
}

/**
 * Applies one SES sending event to the submission it belongs to. Messages are
 * tagged with their account and submission id when sent, and SES returns the
 * tags with every event.
 */
export async function handleDeliveryEvent(
  event: SesSendingEvent,
  deps: DeliveryEventDependencies,
): Promise<DeliveryEventOutcome> {
  const accountId = event.mail?.tags?.['account']?.[0];
  const submissionId = event.mail?.tags?.['submission']?.[0];
  // Ids and counts only: no addresses or diagnostic text, which can quote message content.
  const entry: Record<string, unknown> = {
    eventType: event.eventType,
    messageId: event.mail?.messageId,
    submissionId,
  };
  const finish = (outcome: DeliveryEventOutcome): DeliveryEventOutcome => {
    deps.log?.({ ...entry, outcome });
    return outcome;
  };

  if (event.eventType === 'Bounce') {
    entry['bounceType'] = event.bounce?.bounceType;
    entry['bounceSubType'] = event.bounce?.bounceSubType;
    entry['recipients'] = event.bounce?.bouncedRecipients?.length ?? 0;
  }
  if (event.eventType === 'Complaint') {
    // A complaint does not change whether the message was delivered. SES adds the
    // address to the suppression list; here it is logged so that it can be counted.
    entry['complaintType'] = event.complaint?.complaintFeedbackType;
    entry['recipients'] = event.complaint?.complainedRecipients?.length ?? 0;
    return finish('noted');
  }

  const updates = toUpdates(event);
  if (!updates) return finish('ignored');
  if (
    !accountId ||
    !submissionId ||
    !ID.test(accountId) ||
    !ID.test(submissionId)
  ) {
    return finish('untracked');
  }

  const found = await deps.jmap.recordDelivery(
    { accountId, username: accountId },
    submissionId,
    updates,
  );
  return finish(found ? 'recorded' : 'unknown-submission');
}
