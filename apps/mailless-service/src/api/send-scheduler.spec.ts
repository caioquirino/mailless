import { createAwsSendScheduler } from './send-scheduler.js';

function setup() {
  const queued: Array<Record<string, unknown>> = [];
  const schedules: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let missing = false;
  const scheduler = createAwsSendScheduler({
    sqs: {
      send: (async (command: { input: Record<string, unknown> }) => {
        queued.push(command.input);
        return {};
      }) as never,
    },
    scheduler: {
      send: (async (command: {
        constructor: { name: string };
        input: Record<string, unknown>;
      }) => {
        if (command.constructor.name === 'DeleteScheduleCommand') {
          if (missing) {
            throw Object.assign(new Error('gone'), {
              name: 'ResourceNotFoundException',
            });
          }
          deleted.push(command.input['Name'] as string);
        } else {
          schedules.push(command.input);
        }
        return {};
      }) as never,
    },
    queueUrl: 'https://sqs.example/queue',
    scheduleGroup: 'mailless',
    functionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:send',
    schedulerRoleArn: 'arn:aws:iam::123456789012:role/scheduler',
    deadLetterQueueArn: 'arn:aws:sqs:eu-west-1:123456789012:dead',
    now: () => new Date('2026-10-08T12:00:00.250Z'),
  });
  return {
    scheduler,
    queued,
    schedules,
    deleted,
    loseSchedules: () => (missing = true),
  };
}

const job = (sendAt: string) => ({
  accountId: 'acc-1',
  submissionId: 'es123',
  sendAt: new Date(sendAt),
});

describe('createAwsSendScheduler', () => {
  it('queues a short delay, to the second', async () => {
    const { scheduler, queued, schedules } = setup();
    await scheduler.schedule(job('2026-10-08T12:00:10Z'));
    await scheduler.schedule(job('2026-10-08T12:15:00Z'));
    // Already due: sent to the queue without delay rather than dropped.
    await scheduler.schedule(job('2026-10-08T11:59:00Z'));
    expect(queued).toEqual([
      {
        QueueUrl: 'https://sqs.example/queue',
        MessageBody: '{"accountId":"acc-1","submissionId":"es123"}',
        DelaySeconds: 10,
      },
      expect.objectContaining({ DelaySeconds: 900 }),
      expect.objectContaining({ DelaySeconds: 0 }),
    ]);
    expect(schedules).toHaveLength(0);
  });

  it('makes a one-time schedule for a longer delay', async () => {
    const { scheduler, queued, schedules } = setup();
    await scheduler.schedule(job('2026-10-09T08:30:00.900Z'));
    expect(queued).toHaveLength(0);
    expect(schedules).toEqual([
      {
        Name: 'es123',
        GroupName: 'mailless',
        ScheduleExpression: 'at(2026-10-09T08:30:00)',
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: 'arn:aws:lambda:eu-west-1:123456789012:function:send',
          RoleArn: 'arn:aws:iam::123456789012:role/scheduler',
          Input: '{"accountId":"acc-1","submissionId":"es123"}',
          RetryPolicy: {
            MaximumRetryAttempts: 20,
            MaximumEventAgeInSeconds: 3600,
          },
          DeadLetterConfig: {
            Arn: 'arn:aws:sqs:eu-west-1:123456789012:dead',
          },
        },
      },
    ]);
  });

  it('drops the schedule on cancel, and does not mind if there is none', async () => {
    const { scheduler, deleted, loseSchedules } = setup();
    await scheduler.cancel?.({ accountId: 'acc-1', submissionId: 'es123' });
    expect(deleted).toEqual(['es123']);
    loseSchedules();
    await expect(
      scheduler.cancel?.({ accountId: 'acc-1', submissionId: 'es999' }),
    ).resolves.toBeUndefined();
  });
});
