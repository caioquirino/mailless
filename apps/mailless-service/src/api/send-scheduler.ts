import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SendScheduler } from '@mailless/jmap-server';

export interface AwsSendSchedulerOptions {
  sqs: Pick<SQSClient, 'send'>;
  scheduler: Pick<SchedulerClient, 'send'>;
  /** The queue the send function reads. Used for short delays, to the second. */
  queueUrl: string;
  /** The schedule group for long delays. */
  scheduleGroup: string;
  /** The send function, and the role the scheduling service calls it with. */
  functionArn: string;
  schedulerRoleArn: string;
  /** Where a wake-up goes that kept failing. */
  deadLetterQueueArn: string;
  now?: () => Date;
}

/** What the send function is given, by either route. */
export interface ScheduledSendMessage {
  accountId: string;
  submissionId: string;
}

/** A queue message can be delayed by at most 15 minutes. */
const MAX_QUEUE_DELAY_SECONDS = 900;

/**
 * Wakes the send function when a held message is due, without anything
 * running in between. A delay of up to 15 minutes, which is what "undo send"
 * uses, is a delayed queue message, exact to the second. Anything longer is a
 * one-time schedule, which fires within a minute of its time.
 */
export function createAwsSendScheduler(
  options: AwsSendSchedulerOptions,
): SendScheduler {
  const now = options.now ?? (() => new Date());
  return {
    async schedule({ accountId, submissionId, sendAt }) {
      const message: ScheduledSendMessage = { accountId, submissionId };
      const delay = Math.ceil((sendAt.getTime() - now().getTime()) / 1000);
      if (delay <= MAX_QUEUE_DELAY_SECONDS) {
        await options.sqs.send(
          new SendMessageCommand({
            QueueUrl: options.queueUrl,
            MessageBody: JSON.stringify(message),
            DelaySeconds: Math.max(0, delay),
          }),
        );
        return;
      }
      await options.scheduler.send(
        new CreateScheduleCommand({
          // Submission ids are unique, so the name is too.
          Name: submissionId,
          GroupName: options.scheduleGroup,
          ScheduleExpression: `at(${sendAt.toISOString().slice(0, 19)})`,
          ScheduleExpressionTimezone: 'UTC',
          FlexibleTimeWindow: { Mode: 'OFF' },
          // A schedule that has fired is of no further use.
          ActionAfterCompletion: 'DELETE',
          Target: {
            Arn: options.functionArn,
            RoleArn: options.schedulerRoleArn,
            Input: JSON.stringify(message),
            RetryPolicy: {
              MaximumRetryAttempts: 20,
              MaximumEventAgeInSeconds: 3600,
            },
            DeadLetterConfig: { Arn: options.deadLetterQueueArn },
          },
        }),
      );
    },

    async cancel({ submissionId }) {
      // A queue message cannot be taken back; it wakes the function for nothing.
      try {
        await options.scheduler.send(
          new DeleteScheduleCommand({
            Name: submissionId,
            GroupName: options.scheduleGroup,
          }),
        );
      } catch (error) {
        if ((error as { name?: string }).name !== 'ResourceNotFoundException') {
          throw error;
        }
      }
    },
  };
}
