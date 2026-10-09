import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { IdentityError } from '@mailless/identity';
import { CognitoIdentityProvider } from './cognito-identity-provider.js';

type Sent = { name: string; input: Record<string, unknown> };
type Answer = (input: Record<string, unknown>) => unknown;

const failure = (name: string) =>
  Object.assign(new Error(`${name}: about user ann@example.com`), { name });

/** A client that records what it is sent and answers from a table, by command name. */
function setup(answers: Record<string, Answer | Answer[]> = {}) {
  const sent: Sent[] = [];
  const queues = new Map(
    Object.entries(answers).map(([name, answer]) => [
      name,
      Array.isArray(answer) ? [...answer] : [answer],
    ]),
  );
  const client = {
    send: async (command: {
      constructor: { name: string };
      input: unknown;
    }) => {
      const name = command.constructor.name.replace(/Command$/, '');
      const input = command.input as Record<string, unknown>;
      sent.push({ name, input });
      const queue = queues.get(name) ?? [];
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      return answer ? answer(input) : {};
    },
  } as unknown as Pick<CognitoIdentityProviderClient, 'send'>;
  return {
    sent,
    provider: new CognitoIdentityProvider({ client, userPoolId: 'pool-1' }),
  };
}

const refusal = async (action: () => Promise<unknown>) => {
  const error = await action().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(IdentityError);
  // Cognito's message may name the user; what is passed on never does.
  expect((error as Error).message).not.toContain('ann@example.com');
  return (error as IdentityError).code;
};

describe('CognitoIdentityProvider', () => {
  it('says what it can and cannot do', () => {
    expect(setup().provider.capabilities).toEqual({
      changeOwnPassword: true,
      manageOwnPasskeys: true,
      removePasskeysOfOthers: false,
      manageOwnAuthenticator: true,
    });
  });

  it('reads a user with their roles, and knows when there is none', async () => {
    const created = new Date('2026-01-02T03:04:05Z');
    const { provider, sent } = setup({
      AdminGetUser: [
        () => ({ Username: 'ann', Enabled: true, UserCreateDate: created }),
        () => {
          throw failure('UserNotFoundException');
        },
      ],
      AdminListGroupsForUser: [
        () => ({ Groups: [{ GroupName: 'b' }], NextToken: 'more' }),
        () => ({ Groups: [{ GroupName: 'a' }] }),
      ],
    });
    expect(await provider.getUser('ann')).toEqual({
      username: 'ann',
      enabled: true,
      roles: ['a', 'b'],
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(sent.map(({ name }) => name)).toEqual([
      'AdminGetUser',
      'AdminListGroupsForUser',
      'AdminListGroupsForUser',
    ]);
    expect(sent[0]?.input).toEqual({ UserPoolId: 'pool-1', Username: 'ann' });
    expect(sent[2]?.input['NextToken']).toBe('more');
    expect(await provider.getUser('nobody')).toBeUndefined();
  });

  it('lists every user, page by page', async () => {
    const { provider } = setup({
      ListUsers: [
        () => ({
          Users: [{ Username: 'bob', Enabled: false }],
          PaginationToken: 'next',
        }),
        () => ({ Users: [{ Username: 'ann', Enabled: true }, {}] }),
      ],
      AdminListGroupsForUser: (input) => ({
        Groups: input['Username'] === 'ann' ? [{ GroupName: 'admin' }] : [],
      }),
    });
    expect(await provider.listUsers()).toEqual([
      { username: 'ann', enabled: true, roles: ['admin'], createdAt: null },
      { username: 'bob', enabled: false, roles: [], createdAt: null },
    ]);
  });

  it('creates a user without Cognito writing to them', async () => {
    const { provider, sent } = setup({
      AdminCreateUser: [
        () => ({ User: { Username: 'ann', Enabled: true } }),
        () => {
          throw failure('UsernameExistsException');
        },
      ],
    });
    expect(await provider.createUser('ann')).toMatchObject({
      username: 'ann',
      enabled: true,
      roles: [],
    });
    expect(sent[0]?.input).toEqual({
      UserPoolId: 'pool-1',
      Username: 'ann',
      MessageAction: 'SUPPRESS',
    });
    expect(await refusal(() => provider.createUser('ann'))).toBe('exists');
  });

  it('sends each administrative change as the call Cognito has for it', async () => {
    const { provider, sent } = setup();
    await provider.setEnabled('ann', false);
    await provider.setEnabled('ann', true);
    await provider.setPassword('ann', 'a long enough passphrase');
    await provider.setPassword('ann', 'another long passphrase', {
      temporary: true,
    });
    await provider.grantRole('ann', 'MAILLESS_ADMIN');
    await provider.revokeRole('ann', 'MAILLESS_ADMIN');
    await provider.signOutEverywhere('ann');
    await provider.deleteUser('ann');

    expect(sent.map(({ name }) => name)).toEqual([
      'AdminDisableUser',
      'AdminEnableUser',
      'AdminSetUserPassword',
      'AdminSetUserPassword',
      'AdminAddUserToGroup',
      'AdminRemoveUserFromGroup',
      'AdminUserGlobalSignOut',
      'AdminDeleteUser',
    ]);
    for (const { input } of sent) {
      expect(input).toMatchObject({ UserPoolId: 'pool-1', Username: 'ann' });
    }
    expect(sent[2]?.input['Permanent']).toBe(true);
    expect(sent[3]?.input['Permanent']).toBe(false);
    expect(sent[4]?.input['GroupName']).toBe('MAILLESS_ADMIN');
  });

  it('turns the refusals a caller can act on into reasons, and lets failures through', async () => {
    const throws = (name: string) => () => {
      throw failure(name);
    };
    const { provider } = setup({
      AdminDeleteUser: throws('UserNotFoundException'),
      AdminSetUserPassword: throws('InvalidPasswordException'),
      AdminAddUserToGroup: throws('ResourceNotFoundException'),
      AdminRemoveUserFromGroup: [
        throws('ResourceNotFoundException'),
        throws('UserNotFoundException'),
      ],
      ChangePassword: [
        throws('NotAuthorizedException'),
        throws('LimitExceededException'),
        throws('InvalidPasswordException'),
      ],
      DeleteWebAuthnCredential: throws('ResourceNotFoundException'),
      ListWebAuthnCredentials: throws('NotAuthorizedException'),
      AdminUserGlobalSignOut: throws('InternalErrorException'),
    });
    expect(await refusal(() => provider.deleteUser('ann'))).toBe('notFound');
    expect(await refusal(() => provider.setPassword('ann', 'x'))).toBe(
      'invalidPassword',
    );
    expect(await refusal(() => provider.grantRole('ann', 'nope'))).toBe(
      'notFound',
    );
    // A role that does not exist is not held; a user who does not exist is an error.
    await provider.revokeRole('ann', 'nope');
    expect(await refusal(() => provider.revokeRole('nobody', 'a'))).toBe(
      'notFound',
    );
    const change = () => provider.changeOwnPassword('token', 'old', 'new');
    expect(await refusal(change)).toBe('notAuthorized');
    expect(await refusal(change)).toBe('rateLimited');
    expect(await refusal(change)).toBe('invalidPassword');
    expect(await refusal(() => provider.removeOwnPasskey('token', 'x'))).toBe(
      'notFound',
    );
    expect(await refusal(() => provider.listOwnPasskeys('token'))).toBe(
      'notAuthorized',
    );
    // Not a refusal but a failure: it is thrown as it came.
    await expect(provider.signOutEverywhere('ann')).rejects.toMatchObject({
      name: 'InternalErrorException',
    });
  });

  it('sets up an authenticator app with the user’s own token, and asks for its code only once confirmed', async () => {
    const { provider, sent } = setup({
      GetUser: [
        () => ({ Username: 'ann' }),
        () => ({ Username: 'ann', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }),
      ],
      AssociateSoftwareToken: () => ({ SecretCode: 'JBSWY3DP' }),
      VerifySoftwareToken: [
        () => {
          throw failure('CodeMismatchException');
        },
        () => ({ Status: 'SUCCESS' }),
      ],
    });
    expect(await provider.ownAuthenticator('token-1')).toEqual({
      enabled: false,
    });
    expect(await provider.beginOwnAuthenticator('token-1')).toEqual({
      secret: 'JBSWY3DP',
    });
    expect(
      await refusal(() =>
        provider.confirmOwnAuthenticator('token-1', '000000'),
      ),
    ).toBe('invalidCode');
    // A code that was refused turns nothing on.
    expect(sent.some(({ name }) => name === 'SetUserMFAPreference')).toBe(
      false,
    );
    await provider.confirmOwnAuthenticator('token-1', '123456');
    expect(await provider.ownAuthenticator('token-1')).toEqual({
      enabled: true,
    });
    await provider.removeOwnAuthenticator('token-1');

    expect(sent.slice(-4).map(({ name, input }) => [name, input])).toEqual([
      ['VerifySoftwareToken', { AccessToken: 'token-1', UserCode: '123456' }],
      [
        'SetUserMFAPreference',
        {
          AccessToken: 'token-1',
          SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
        },
      ],
      ['GetUser', { AccessToken: 'token-1' }],
      [
        'SetUserMFAPreference',
        {
          AccessToken: 'token-1',
          SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        },
      ],
    ]);
  });

  it('acts on a user’s own credentials with the user’s own token', async () => {
    const { provider, sent } = setup({
      ListWebAuthnCredentials: [
        () => ({
          Credentials: [
            {
              CredentialId: 'c1',
              FriendlyCredentialName: 'Phone',
              CreatedAt: new Date('2026-05-06T07:08:09Z'),
            },
          ],
          NextToken: 'more',
        }),
        () => ({ Credentials: [{ CredentialId: 'c2' }, {}] }),
      ],
    });
    expect(await provider.listOwnPasskeys('token-1')).toEqual([
      { id: 'c1', name: 'Phone', createdAt: '2026-05-06T07:08:09.000Z' },
      { id: 'c2', name: null, createdAt: null },
    ]);
    await provider.removeOwnPasskey('token-1', 'c1');
    await provider.changeOwnPassword('token-1', 'old one', 'new one');

    expect(sent.map(({ name, input }) => [name, input])).toEqual([
      ['ListWebAuthnCredentials', { AccessToken: 'token-1' }],
      [
        'ListWebAuthnCredentials',
        { AccessToken: 'token-1', NextToken: 'more' },
      ],
      [
        'DeleteWebAuthnCredential',
        { AccessToken: 'token-1', CredentialId: 'c1' },
      ],
      [
        'ChangePassword',
        {
          AccessToken: 'token-1',
          PreviousPassword: 'old one',
          ProposedPassword: 'new one',
        },
      ],
    ]);
    // None of these name the pool: the token says whose credentials they are.
    for (const { input } of sent)
      expect(input).not.toHaveProperty('UserPoolId');
  });
});
