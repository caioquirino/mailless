import { SetFailure } from '@mailless/jmap-core';
import type { JmapServer } from '@mailless/jmap-server';
import type { SESEvent, SESEventRecord } from 'aws-lambda';

/** Where SES leaves raw messages before they are imported. */
export interface InboundStore {
  get(messageId: string): Promise<Uint8Array | null>;
  delete(messageId: string): Promise<void>;
}

export interface IngestDependencies {
  jmap: Pick<JmapServer, 'importMessage' | 'provisionAccount'>;
  inbound: InboundStore;
  /** Recipient address to account id, or undefined when nobody owns the address. */
  resolveAccount(recipient: string): string | undefined;
  log?(entry: Record<string, unknown>): void;
}

export type IngestOutcome =
  | 'delivered'
  | 'no-recipient'
  | 'discarded-virus'
  | 'invalid-message'
  | 'missing-object';

function toUtcDate(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.?0+Z$/, 'Z');
}

async function ingestRecord(
  record: SESEventRecord,
  deps: IngestDependencies,
): Promise<IngestOutcome> {
  const { mail, receipt } = record.ses;
  const messageId = mail.messageId;

  // One delivery per account, even when several of its addresses were recipients.
  const accounts = new Map<string, string>();
  for (const recipient of receipt.recipients) {
    const accountId = deps.resolveAccount(recipient);
    if (accountId !== undefined && !accounts.has(accountId)) {
      accounts.set(accountId, recipient.toLowerCase());
    }
  }
  if (accounts.size === 0) {
    await deps.inbound.delete(messageId);
    return 'no-recipient';
  }

  if (receipt.virusVerdict.status === 'FAIL') {
    await deps.inbound.delete(messageId);
    return 'discarded-virus';
  }

  const raw = await deps.inbound.get(messageId);
  if (!raw) return 'missing-object';

  const isSpam = receipt.spamVerdict.status === 'FAIL';
  const receivedAt = toUtcDate(mail.timestamp);

  for (const [accountId, username] of accounts) {
    const auth = { accountId, username };
    await deps.jmap.provisionAccount(auth);
    try {
      await deps.jmap.importMessage(auth, raw, {
        mailboxRole: isSpam ? 'junk' : 'inbox',
        ...(isSpam ? { keywords: { $junk: true as const } } : {}),
        ...(receivedAt ? { receivedAt } : {}),
        // SES retries failed invocations; the key makes a repeat a no-op for accounts already done.
        idempotencyKey: `ses:${messageId}`,
      });
    } catch (error) {
      if (error instanceof SetFailure && error.error.type === 'invalidEmail') {
        // Retrying cannot help. The object is left for the bucket lifecycle rule to expire.
        return 'invalid-message';
      }
      throw error;
    }
  }

  await deps.inbound.delete(messageId);
  return 'delivered';
}

/**
 * Handles the Lambda action of an SES receipt rule whose S3 action has
 * already stored the raw message. Throws when a delivery fails so that the
 * invocation is retried.
 */
export async function ingest(
  event: SESEvent,
  deps: IngestDependencies,
): Promise<IngestOutcome[]> {
  const outcomes: IngestOutcome[] = [];
  for (const record of event.Records) {
    const outcome = await ingestRecord(record, deps);
    // Message ids and outcomes only: no addresses, subjects or content in logs.
    deps.log?.({ messageId: record.ses.mail.messageId, outcome });
    outcomes.push(outcome);
  }
  return outcomes;
}
