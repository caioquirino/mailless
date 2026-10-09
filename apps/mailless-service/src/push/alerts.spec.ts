import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import type { CalendarAlert } from '@mailless/jmap-server';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  ALERTS,
  createAwsAlertScheduler,
  isAlertWake,
  rescheduleAlerts,
  scheduleName,
  sendAlerts,
} from './alerts.js';
import { pushChanges } from './state-stream.js';

const NOW = new Date('2026-10-12T07:30:20Z');

function scheduling(fail: Record<string, string> = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const scheduler = createAwsAlertScheduler({
    scheduler: {
      send: async (command: {
        constructor: { name: string };
        input: unknown;
      }) => {
        const name = command.constructor.name.replace(/Command$/, '');
        sent.push({ name, input: command.input as Record<string, unknown> });
        if (fail[name]) throw Object.assign(new Error(), { name: fail[name] });
        return {};
      },
    } as unknown as Pick<SchedulerClient, 'send'>,
    scheduleGroup: 'mailless',
    functionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:push',
    schedulerRoleArn: 'arn:aws:iam::123456789012:role/scheduler',
    deadLetterQueueArn: 'arn:aws:sqs:eu-west-1:123456789012:dead',
    now: () => NOW,
  });
  return { sent, scheduler };
}

const alert = (more: Partial<CalendarAlert> = {}): CalendarAlert => ({
  eventId: 'ev1',
  title: 'Dentist',
  utcStart: '2026-10-12T08:00:00.000Z',
  utcEnd: '2026-10-12T09:00:00.000Z',
  showWithoutTime: false,
  location: 'Dr. Holm',
  at: '2026-10-12T07:30:00.000Z',
  ...more,
});

describe('the wake-up an account has for its reminders', () => {
  it('is one schedule, named by what the account’s id comes to', async () => {
    const { sent, scheduler } = scheduling();
    await scheduler.schedule(
      'ann@example.com',
      new Date('2026-10-14T07:30:00Z'),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe('CreateSchedule');
    expect(sent[0]?.input).toMatchObject({
      Name: scheduleName('ann@example.com'),
      GroupName: 'mailless',
      ScheduleExpression: 'at(2026-10-14T07:30:00)',
      ActionAfterCompletion: 'DELETE',
      Target: {
        Input: JSON.stringify({
          calendarAlerts: { accountId: 'ann@example.com' },
        }),
      },
    });
    // The name says nothing of whose it is, and is one a schedule may have.
    expect(scheduleName('ann@example.com')).toMatch(/^alerts-[0-9a-f]{40}$/);
  });

  it('is moved when there is one already, and never set for a moment that has passed', async () => {
    const { sent, scheduler } = scheduling({
      CreateSchedule: 'ConflictException',
    });
    await scheduler.schedule('ann', new Date('2026-10-12T07:00:00Z'));
    expect(sent.map((each) => each.name)).toEqual([
      'CreateSchedule',
      'UpdateSchedule',
    ]);
    expect(sent[1]?.input['ScheduleExpression']).toBe(
      'at(2026-10-12T07:30:35)',
    );
  });

  it('is taken away when there is nothing to be reminded of, whether or not it was there', async () => {
    const { sent, scheduler } = scheduling({
      DeleteSchedule: 'ResourceNotFoundException',
    });
    await scheduler.schedule('ann', null);
    expect(sent.map((each) => each.name)).toEqual(['DeleteSchedule']);
    await expect(
      scheduling({
        DeleteSchedule: 'AccessDeniedException',
      }).scheduler.schedule('ann', null),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });
});

describe('being woken for an account’s reminders', () => {
  it('tells its devices what is due, and sets the next wake-up', async () => {
    const pushed: unknown[][] = [];
    const set: Array<[string, Date | null]> = [];
    const logs: Record<string, unknown>[] = [];
    const next = new Date('2026-10-14T07:30:00Z');
    await sendAlerts(
      { calendarAlerts: { accountId: 'ann' } },
      {
        jmap: {
          takeCalendarAlerts: async (auth, now) => {
            expect(auth.accountId).toBe('ann');
            expect(now).toEqual(NOW);
            return { due: [alert(), alert({ location: null })], next };
          },
          nextCalendarAlert: async () => null,
          pushStateChange: async (...args) => {
            pushed.push(args);
            return { sent: 1, failed: 0, removed: 0 };
          },
        },
        scheduler: { schedule: async (id, at) => void set.push([id, at]) },
        now: () => NOW,
        log: (entry) => logs.push(entry),
      },
    );
    expect(pushed).toEqual([
      [
        'ann',
        ['CalendarAlert'],
        {
          [ALERTS]: [
            {
              eventId: 'ev1',
              title: 'Dentist',
              utcStart: '2026-10-12T08:00:00.000Z',
              utcEnd: '2026-10-12T09:00:00.000Z',
              showWithoutTime: false,
              location: 'Dr. Holm',
            },
            {
              eventId: 'ev1',
              title: 'Dentist',
              utcStart: '2026-10-12T08:00:00.000Z',
              utcEnd: '2026-10-12T09:00:00.000Z',
              showWithoutTime: false,
            },
          ],
        },
      ],
    ]);
    expect(set).toEqual([['ann', next]]);
    // Counts only: not whose reminders, and nothing of what they are for.
    expect(logs).toEqual([
      {
        event: 'calendar-alerts',
        due: 2,
        next: true,
        sent: 1,
        failed: 0,
        removed: 0,
      },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/ann|Dentist/);
  });

  it('pushes nothing when nothing is due, and still sets the next wake-up', async () => {
    const set: Array<[string, Date | null]> = [];
    let pushes = 0;
    await sendAlerts(
      { calendarAlerts: { accountId: 'ann' } },
      {
        jmap: {
          takeCalendarAlerts: async () => ({ due: [], next: null }),
          nextCalendarAlert: async () => null,
          pushStateChange: async () => {
            pushes += 1;
            return { sent: 0, failed: 0, removed: 0 };
          },
        },
        scheduler: { schedule: async (id, at) => void set.push([id, at]) },
      },
    );
    expect(pushes).toBe(0);
    expect(set).toEqual([['ann', null]]);
  });

  it('is told apart from the table’s changes', () => {
    expect(isAlertWake({ calendarAlerts: { accountId: 'ann' } })).toBe(true);
    expect(isAlertWake({ Records: [] })).toBe(false);
    expect(isAlertWake(null)).toBe(false);
  });
});

describe('a calendar that changed', () => {
  const event = (...types: string[]) =>
    ({
      Records: types.map((type) => ({
        eventName: 'MODIFY',
        dynamodb: { Keys: { pk: { S: 'S#ann' }, sk: { S: type } } },
      })),
    }) as unknown as DynamoDBStreamEvent;
  const jmap = {
    pushStateChange: async () => ({ sent: 0, failed: 0, removed: 0 }),
  };

  it('has its wake-up set again, and mail that changed does not', async () => {
    const changed: string[] = [];
    const calendarChanged = async (accountId: string) =>
      void changed.push(accountId);
    await pushChanges(event('Email', 'Thread'), { jmap, calendarChanged });
    expect(changed).toEqual([]);
    await pushChanges(event('CalendarEvent', 'Calendar'), {
      jmap,
      calendarChanged,
    });
    expect(changed).toEqual(['ann']);
    // Having told of reminders is not a calendar that changed: it would never end.
    await pushChanges(event('CalendarAlertState'), { jmap, calendarChanged });
    expect(changed).toEqual(['ann']);
  });

  it('is still pushed when the wake-up could not be set', async () => {
    const logs: Record<string, unknown>[] = [];
    await pushChanges(event('CalendarEvent'), {
      jmap,
      calendarChanged: async () => {
        throw Object.assign(new Error('about ann'), {
          name: 'ThrottlingException',
        });
      },
      log: (entry) => logs.push(entry),
    });
    expect(logs.at(-1)).toEqual({
      event: 'calendar-alerts-rescheduled',
      outcome: 'ThrottlingException',
    });
  });

  it('sets the wake-up for when the server says the next reminder is', async () => {
    const set: Array<[string, Date | null]> = [];
    const next = new Date('2026-10-14T07:30:00Z');
    await rescheduleAlerts('ann', {
      jmap: {
        nextCalendarAlert: async () => next,
        takeCalendarAlerts: async () => ({ due: [], next: null }),
        pushStateChange: jmap.pushStateChange,
      },
      scheduler: { schedule: async (id, at) => void set.push([id, at]) },
    });
    expect(set).toEqual([['ann', next]]);
  });
});
