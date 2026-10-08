import type { Directory } from '@mailless/directory';
import type { StorageAdapter } from '@mailless/jmap-server';

export interface PurgeDependencies {
  directory: Pick<Directory, 'account' | 'deleteAccount'>;
  storage: StorageAdapter;
  /** False once there is too little time left to start another step. */
  keepGoing(): boolean;
  /** Arranges for the purge to be taken up again, when it ran out of time. */
  continueLater(accountId: string): Promise<void>;
  log?(entry: Record<string, unknown>): void;
}

/** A request arrives as messages from the queue, or directly when run by hand. */
export type PurgeEvent =
  { accountId?: unknown } | { Records: Array<{ body: string }> };

export type PurgeOutcome =
  'malformed' | 'no-account' | 'not-closed' | 'continued' | 'done';

const ACCOUNT_ID = /^[a-z0-9_-]{1,64}$/;

/**
 * Removes everything a closed account had, and then the account itself, so
 * that its id is free again.
 *
 * Whoever asks is not taken at their word: the directory must say the account
 * is on its way out, or nothing is touched. A request for an open account is
 * logged and dropped.
 *
 * It may be cut short and run again as often as it takes. What is gone stays
 * gone, and the account stays listed until nothing is left.
 */
export async function purgeAccounts(
  event: PurgeEvent,
  deps: PurgeDependencies,
): Promise<PurgeOutcome[]> {
  const requests: unknown[] =
    'Records' in event
      ? event.Records.map((record) => {
          try {
            return JSON.parse(record.body) as unknown;
          } catch {
            return undefined;
          }
        })
      : [event];

  const outcomes: PurgeOutcome[] = [];
  for (const request of requests) {
    const { accountId } = (request ?? {}) as Record<string, unknown>;
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
      deps.log?.({ event: 'purge', outcome: 'malformed' });
      outcomes.push('malformed');
      continue;
    }
    const outcome = await purgeAccount(accountId, deps);
    deps.log?.({ event: 'purge', account: accountId, outcome });
    outcomes.push(outcome);
  }
  return outcomes;
}

async function purgeAccount(
  accountId: string,
  deps: PurgeDependencies,
): Promise<PurgeOutcome> {
  const account = await deps.directory.account(accountId);
  if (!account) return 'no-account';
  if (account.status !== 'deleting') return 'not-closed';

  // Content first. Were the metadata to go first and the rest fail for good,
  // what was left would be mail that nothing names any more.
  const finished =
    (await deps.storage.blobs.purge(accountId, deps.keepGoing)) &&
    (await deps.storage.metadata.purge(accountId, deps.keepGoing));
  if (!finished) {
    await deps.continueLater(accountId);
    return 'continued';
  }
  await deps.directory.deleteAccount(accountId);
  return 'done';
}
