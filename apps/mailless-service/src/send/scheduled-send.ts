import type { JmapServer } from '@mailless/jmap-server';

export interface ScheduledSendDependencies {
  jmap: Pick<JmapServer, 'sendScheduled'>;
  log?(entry: Record<string, unknown>): void;
}

/** A wake-up arrives straight from a schedule, or as messages from the queue. */
export type ScheduledSendEvent =
  | { accountId?: unknown; submissionId?: unknown }
  | { Records: Array<{ body: string }> };

const ID = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Sends the held messages a wake-up names. Throws when one could not be sent
 * yet, so that whatever woke the function tries again; a wake-up that makes
 * no sense is logged and dropped, since trying again cannot improve it.
 */
export async function sendScheduled(
  event: ScheduledSendEvent,
  deps: ScheduledSendDependencies,
): Promise<void> {
  const messages: unknown[] =
    'Records' in event
      ? event.Records.map((record) => {
          try {
            return JSON.parse(record.body) as unknown;
          } catch {
            return undefined;
          }
        })
      : [event];

  for (const message of messages) {
    const { accountId, submissionId } = (message ?? {}) as Record<
      string,
      unknown
    >;
    if (
      typeof accountId !== 'string' ||
      typeof submissionId !== 'string' ||
      !ID.test(accountId) ||
      !ID.test(submissionId)
    ) {
      deps.log?.({ event: 'scheduled-send', outcome: 'malformed' });
      continue;
    }
    const outcome = await deps.jmap.sendScheduled(
      { accountId, username: accountId },
      submissionId,
    );
    deps.log?.({ event: 'scheduled-send', submissionId, outcome });
    if (outcome === 'in-progress') {
      // Another attempt holds it. If that one died, this message is the only
      // thing that will come back for it.
      throw new Error(`Submission ${submissionId} is still being sent`);
    }
  }
}
