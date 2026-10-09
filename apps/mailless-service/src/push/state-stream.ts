import type { JmapServer } from '@mailless/jmap-server';
import { parseStateKey } from '@mailless/storage-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { ARRIVED, type Arrival } from './arrivals.js';

export interface PushDependencies {
  jmap: Pick<JmapServer, 'pushStateChange'>;
  /**
   * What reached an account just now, for the notification to say. Left out,
   * or failing, a push says only that something changed.
   */
  arrived?(accountId: string): Promise<Arrival[]>;
  log?(entry: Record<string, unknown>): void;
}

/**
 * The accounts whose data changed, each with the data types that did. The
 * metadata table writes one state item per data type on every commit, so
 * those items in the table's stream are the list of what changed.
 */
export function changedStates(
  event: DynamoDBStreamEvent,
): Map<string, Set<string>> {
  const changes = new Map<string, Set<string>>();
  for (const record of event.Records) {
    if (record.eventName === 'REMOVE') continue;
    const keys = record.dynamodb?.Keys;
    const state = parseStateKey({
      ...(keys?.['pk']?.S === undefined ? {} : { pk: keys['pk'].S }),
      ...(keys?.['sk']?.S === undefined ? {} : { sk: keys['sk'].S }),
    });
    if (!state) continue;
    const types = changes.get(state.accountId) ?? new Set<string>();
    types.add(state.type);
    changes.set(state.accountId, types);
  }
  return changes;
}

/**
 * Tells push subscriptions about the changes in a batch of stream records.
 * Several changes to one account within a batch become one push.
 */
export async function pushChanges(
  event: DynamoDBStreamEvent,
  deps: PushDependencies,
): Promise<void> {
  for (const [accountId, types] of changedStates(event)) {
    // Only mail arriving is something to tell of; and not being able to tell must not stop the push.
    const arrived =
      types.has('EmailDelivery') && deps.arrived
        ? await deps.arrived(accountId).catch(() => undefined)
        : undefined;
    const report = await deps.jmap.pushStateChange(
      accountId,
      [...types],
      arrived && arrived.length > 0 ? { [ARRIVED]: arrived } : undefined,
    );
    // Type names and counts only: no account, no push service address, nothing of the mail.
    deps.log?.({ event: 'push', types: [...types].sort(), ...report });
  }
}
