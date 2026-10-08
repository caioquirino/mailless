import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  configurationFromEnvironment,
  directoryFromEnvironment,
} from './directory.js';

const noClient = {} as DynamoDBDocumentClient;

describe('directoryFromEnvironment', () => {
  it('reads the accounts the environment describes when there is no table', async () => {
    const directory = directoryFromEnvironment(
      {
        MAILBOXES: '{"Ann@example.com":"ann","*@example.com":"team"}',
        ACCOUNT_NAMES: '{"ann":"Ann A"}',
        ACCOUNT_SHARES: '{"team":{"members":["ann"]}}',
      },
      noClient,
    );
    expect(await directory.resolveAddress('ann@example.com')).toBe('ann');
    expect(await directory.resolveAddress('x@example.com')).toBe('team');
    expect(await directory.account('ann')).toMatchObject({
      name: 'Ann A',
      status: 'active',
    });
    expect(await directory.addressesOf('team')).toEqual(['*@example.com']);
    expect(await directory.sharedWith('ann')).toEqual({ team: 'member' });
  });

  it('has no accounts when the environment says nothing', async () => {
    const directory = directoryFromEnvironment({}, noClient);
    expect(await directory.resolveAddress('ann@example.com')).toBeUndefined();
    expect(await directory.account('ann')).toBeUndefined();
  });

  it('says what is wrong with the environment when asked, not before', async () => {
    const directory = directoryFromEnvironment(
      { MAILBOXES: '{"a@example.com":"Not Valid"}' },
      noClient,
    );
    await expect(directory.account('ann')).rejects.toThrow(/account id/);
    expect(() =>
      configurationFromEnvironment({ ACCOUNT_SHARES: '[]' }),
    ).toThrow(/ACCOUNT_SHARES must be a JSON object/);
  });
});
