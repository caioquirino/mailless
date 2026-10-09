import { SetFailure } from '@mailless/jmap-core';
import type { JmapServer } from '@mailless/jmap-server';
import type { SESEvent, SESEventRecord, SESReceipt } from 'aws-lambda';

/** Where SES leaves raw messages before they are imported. */
export interface InboundStore {
  get(messageId: string): Promise<Uint8Array | null>;
  delete(messageId: string): Promise<void>;
}

export interface IngestDependencies {
  jmap: Pick<JmapServer, 'importMessage' | 'provisionAccount'>;
  inbound: InboundStore;
  /**
   * Recipient address to account id, or undefined when the address delivers
   * to nobody: it belongs to no account, or to one that is being deleted.
   */
  resolveAccount(recipient: string): Promise<string | undefined>;
  log?(entry: Record<string, unknown>): void;
}

export type IngestOutcome =
  | 'delivered'
  | 'no-recipient'
  | 'discarded-virus'
  | 'invalid-message'
  | 'missing-object';

/**
 * Whether the sender is who the message says: what the receiving side's
 * checks of it came to (SPF, DKIM and DMARC), in one word.
 *
 * - `failed`: the domain in the From line publishes how its mail is signed,
 *   and this message is not signed so. It is what forged mail looks like.
 * - `unverified`: nothing vouches for the message, and the domain asks for
 *   nothing. Not a sign of forgery, and no reason to believe the From line.
 * - `ok`: something vouches for it, or the checks did not run.
 */
export type SenderCheck = 'ok' | 'unverified' | 'failed';

/** On mail that claims a sender its domain does not vouch for (the IANA keyword for it). */
export const PHISHING = '$phishing';
/** On mail nothing vouches for. Ours: there is no registered keyword for it. */
export const UNVERIFIED = 'mailless-unverified';

const vouchesNot = (verdict: { status: string } | undefined): boolean =>
  verdict?.status === 'FAIL' || verdict?.status === 'GRAY';

export function senderCheck(
  receipt: Pick<SESReceipt, 'spfVerdict' | 'dkimVerdict' | 'dmarcVerdict'>,
): SenderCheck {
  if (receipt.dmarcVerdict?.status === 'FAIL') return 'failed';
  return receipt.dmarcVerdict?.status === 'GRAY' &&
    vouchesNot(receipt.spfVerdict) &&
    vouchesNot(receipt.dkimVerdict)
    ? 'unverified'
    : 'ok';
}

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
    const accountId = await deps.resolveAccount(recipient);
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

  const sender = senderCheck(receipt);
  // A domain that says what to do with mail forged in its name is taken at
  // its word: set aside. One that only wants to be told is shown with a warning.
  const forged =
    sender === 'failed' &&
    (receipt.dmarcPolicy === 'quarantine' || receipt.dmarcPolicy === 'reject');
  const isSpam = receipt.spamVerdict.status === 'FAIL' || forged;
  const keywords: Record<string, true> = {
    ...(isSpam ? { $junk: true } : {}),
    ...(sender === 'failed' ? { [PHISHING]: true } : {}),
    ...(sender === 'unverified' ? { [UNVERIFIED]: true } : {}),
  };
  const receivedAt = toUtcDate(mail.timestamp);

  for (const [accountId, username] of accounts) {
    const auth = { accountId, username };
    await deps.jmap.provisionAccount(auth);
    try {
      await deps.jmap.importMessage(auth, raw, {
        mailboxRole: isSpam ? 'junk' : 'inbox',
        delivery: true,
        ...(Object.keys(keywords).length > 0 ? { keywords } : {}),
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
