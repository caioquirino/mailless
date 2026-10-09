import { createHash } from 'node:crypto';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  UpdateScheduleCommand,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';
import type { CalendarAlert, JmapServer } from '@mailless/jmap-server';

/*
 * Calendar reminders. Nothing runs while nothing is due: each account that
 * has events has one wake-up, set for its next reminder. When it comes, the
 * account's devices are told what is due and the wake-up is set again for
 * the one after. Whenever the account's events change it is set again too,
 * since the next reminder may be another one now.
 */

/** What this function is woken with for an account's reminders. */
export interface AlertWake {
  calendarAlerts: { accountId: string };
}

export const isAlertWake = (event: unknown): event is AlertWake =>
  typeof event === 'object' &&
  event !== null &&
  typeof (event as Partial<AlertWake>).calendarAlerts?.accountId === 'string';

/** The property of a push that carries them. Not part of JMAP: the webmail's worker reads it. */
export const ALERTS = 'mailless:alerts';
/** The type a subscription names to be told of reminders. */
export const CALENDAR_ALERT = 'CalendarAlert';

/** Sets, moves or removes the one wake-up an account has. */
export interface AlertScheduler {
  schedule(accountId: string, at: Date | null): Promise<void>;
}

export interface AwsAlertSchedulerOptions {
  scheduler: Pick<SchedulerClient, 'send'>;
  scheduleGroup: string;
  /** This function, and the role the scheduling service calls it with. */
  functionArn: string;
  schedulerRoleArn: string;
  deadLetterQueueArn: string;
  now?: () => Date;
}

/** A schedule is named by what an account's id comes to: the id itself may hold what a name may not. */
export const scheduleName = (accountId: string) =>
  `alerts-${createHash('sha256').update(accountId).digest('hex').slice(0, 40)}`;

/** A schedule cannot be set for a moment that has passed, or is about to. */
const SOONEST_MS = 15_000;

export function createAwsAlertScheduler(
  options: AwsAlertSchedulerOptions,
): AlertScheduler {
  const now = options.now ?? (() => new Date());
  return {
    async schedule(accountId, at) {
      const Name = scheduleName(accountId);
      const GroupName = options.scheduleGroup;
      if (at === null) {
        try {
          await options.scheduler.send(
            new DeleteScheduleCommand({ Name, GroupName }),
          );
        } catch (error) {
          if (
            (error as { name?: string }).name !== 'ResourceNotFoundException'
          ) {
            throw error;
          }
        }
        return;
      }
      const when = new Date(
        Math.max(at.getTime(), now().getTime() + SOONEST_MS),
      );
      const wake: AlertWake = { calendarAlerts: { accountId } };
      const schedule = {
        Name,
        GroupName,
        ScheduleExpression: `at(${when.toISOString().slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' as const },
        // The wake-up sets the next one itself: one that has fired is of no further use.
        ActionAfterCompletion: 'DELETE' as const,
        Target: {
          Arn: options.functionArn,
          RoleArn: options.schedulerRoleArn,
          Input: JSON.stringify(wake),
          RetryPolicy: {
            MaximumRetryAttempts: 5,
            // A reminder that could not be told of for this long is not worth telling.
            MaximumEventAgeInSeconds: 900,
          },
          DeadLetterConfig: { Arn: options.deadLetterQueueArn },
        },
      };
      try {
        await options.scheduler.send(new CreateScheduleCommand(schedule));
      } catch (error) {
        // There is one already: it is moved.
        if ((error as { name?: string }).name !== 'ConflictException') {
          throw error;
        }
        await options.scheduler.send(new UpdateScheduleCommand(schedule));
      }
    },
  };
}

export interface AlertDependencies {
  jmap: Pick<
    JmapServer,
    'takeCalendarAlerts' | 'nextCalendarAlert' | 'pushStateChange'
  >;
  scheduler: AlertScheduler;
  now?: () => Date;
  log?(entry: Record<string, unknown>): void;
}

/** A push is small: this many reminders, each cut to what a notification shows anyway. */
const MOST = 4;

function cut(text: string, longest: number): string {
  const letters = [...text.trim()];
  return letters.length > longest
    ? `${letters.slice(0, longest - 1).join('')}…`
    : letters.join('');
}

/** What a notification needs of a reminder, and no more. */
const told = (alert: CalendarAlert) => ({
  eventId: alert.eventId,
  title: cut(alert.title, 80),
  utcStart: alert.utcStart,
  utcEnd: alert.utcEnd,
  showWithoutTime: alert.showWithoutTime,
  ...(alert.location ? { location: cut(alert.location, 60) } : {}),
});

const auth = (accountId: string) => ({ accountId, username: accountId });

/**
 * Woken for an account: tells its devices of the reminders that have come
 * due, and sets the wake-up for the next.
 */
export async function sendAlerts(
  wake: AlertWake,
  deps: AlertDependencies,
): Promise<void> {
  const { accountId } = wake.calendarAlerts;
  const now = deps.now?.() ?? new Date();
  const { due, next } = await deps.jmap.takeCalendarAlerts(
    auth(accountId),
    now,
  );
  const report =
    due.length > 0
      ? await deps.jmap.pushStateChange(accountId, [CALENDAR_ALERT], {
          [ALERTS]: due.slice(0, MOST).map(told),
        })
      : undefined;
  await deps.scheduler.schedule(accountId, next);
  // Counts only: no account, and nothing of what the reminders are for.
  deps.log?.({
    event: 'calendar-alerts',
    due: due.length,
    next: next !== null,
    ...report,
  });
}

/** An account's events changed: its next reminder may be another one now. */
export async function rescheduleAlerts(
  accountId: string,
  deps: Pick<AlertDependencies, 'jmap' | 'scheduler' | 'now'>,
): Promise<void> {
  await deps.scheduler.schedule(
    accountId,
    await deps.jmap.nextCalendarAlert(
      auth(accountId),
      deps.now?.() ?? new Date(),
    ),
  );
}
