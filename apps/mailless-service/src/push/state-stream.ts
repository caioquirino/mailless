import type { JmapServer } from '@mailless/jmap-server';
import { parseStateKey } from '@mailless/storage-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';

export interface PushDependencies {
  jmap: Pick<JmapServer, 'pushStateChange'>;
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
    const report = await deps.jmap.pushStateChange(accountId, [...types]);
    // Type names and counts only: no account, no push service address.
    deps.log?.({ event: 'push', types: [...types].sort(), ...report });
  }
}
