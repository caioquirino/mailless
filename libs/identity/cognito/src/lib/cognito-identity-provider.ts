import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  AssociateSoftwareTokenCommand,
  ChangePasswordCommand,
  DeleteWebAuthnCredentialCommand,
  GetUserCommand,
  ListUsersCommand,
  ListWebAuthnCredentialsCommand,
  SetUserMFAPreferenceCommand,
  VerifySoftwareTokenCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  IdentityError,
  type IdentityCapabilities,
  type IdentityErrorCode,
  type IdentityProvider,
  type IdentityUser,
  type Passkey,
} from '@mailless/identity';

export interface CognitoIdentityProviderOptions {
  /** Only `send` is used, so anything that sends commands will do. */
  client: Pick<CognitoIdentityProviderClient, 'send'>;
  userPoolId: string;
}

/** What Cognito's errors mean to a caller. Anything else is a failure, and is thrown as it came. */
const MEANINGS: Record<string, IdentityErrorCode> = {
  UsernameExistsException: 'exists',
  UserNotFoundException: 'notFound',
  ResourceNotFoundException: 'notFound',
  InvalidPasswordException: 'invalidPassword',
  PasswordHistoryPolicyViolationException: 'invalidPassword',
  NotAuthorizedException: 'notAuthorized',
  UserNotConfirmedException: 'notAuthorized',
  PasswordResetRequiredException: 'notAuthorized',
  CodeMismatchException: 'invalidCode',
  EnableSoftwareTokenMFAException: 'invalidCode',
  LimitExceededException: 'rateLimited',
  TooManyRequestsException: 'rateLimited',
  InvalidParameterException: 'invalid',
};

const MESSAGES: Record<IdentityErrorCode, string> = {
  exists: 'The user already exists',
  notFound: 'There is no such user, role or passkey',
  invalidPassword: 'The password does not meet the password policy',
  notAuthorized: 'The token or the current password was not accepted',
  invalidCode: 'The code is not the one the authenticator app shows now',
  rateLimited: 'Too many attempts; try again later',
  unsupported: 'Not supported',
  invalid: 'The request was not valid',
};

/** Runs a call, turning the errors a caller can act on into IdentityError. */
async function translated<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const code = MEANINGS[(error as { name?: string }).name ?? ''];
    if (!code) throw error;
    // Cognito's own message may name the user; ours does not.
    throw new IdentityError(code, MESSAGES[code]);
  }
}

const iso = (date: Date | undefined) => (date ? date.toISOString() : null);

/**
 * Amazon Cognito as the identity provider. Users are created without a way
 * to sign in and without Cognito writing to them: an administrator sets a
 * password, and the user adds a passkey on Cognito's own page.
 */
export class CognitoIdentityProvider implements IdentityProvider {
  readonly capabilities: IdentityCapabilities = {
    changeOwnPassword: true,
    manageOwnPasskeys: true,
    // Cognito has no call by which an administrator removes another user's passkey.
    removePasskeysOfOthers: false,
    // Needs a user pool where a second factor is optional, and a token with the scope for it.
    manageOwnAuthenticator: true,
  };

  private readonly client: Pick<CognitoIdentityProviderClient, 'send'>;
  private readonly userPoolId: string;

  constructor(options: CognitoIdentityProviderOptions) {
    this.client = options.client;
    this.userPoolId = options.userPoolId;
  }

  private get pool() {
    return { UserPoolId: this.userPoolId };
  }

  private async rolesOf(username: string): Promise<string[]> {
    const roles: string[] = [];
    let NextToken: string | undefined;
    do {
      const page = await this.client.send(
        new AdminListGroupsForUserCommand({
          ...this.pool,
          Username: username,
          NextToken,
        }),
      );
      for (const group of page.Groups ?? []) {
        if (group.GroupName) roles.push(group.GroupName);
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return roles.sort();
  }

  async getUser(username: string): Promise<IdentityUser | undefined> {
    try {
      const user = await this.client.send(
        new AdminGetUserCommand({ ...this.pool, Username: username }),
      );
      return {
        username: user.Username ?? username,
        enabled: user.Enabled ?? false,
        roles: await this.rolesOf(username),
        createdAt: iso(user.UserCreateDate),
      };
    } catch (error) {
      if ((error as { name?: string }).name === 'UserNotFoundException') {
        return undefined;
      }
      throw error;
    }
  }

  async listUsers(): Promise<IdentityUser[]> {
    const users: IdentityUser[] = [];
    let PaginationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListUsersCommand({ ...this.pool, PaginationToken }),
      );
      for (const user of page.Users ?? []) {
        if (!user.Username) continue;
        users.push({
          username: user.Username,
          enabled: user.Enabled ?? false,
          roles: await this.rolesOf(user.Username),
          createdAt: iso(user.UserCreateDate),
        });
      }
      PaginationToken = page.PaginationToken;
    } while (PaginationToken);
    return users.sort((a, b) => (a.username < b.username ? -1 : 1));
  }

  async createUser(username: string): Promise<IdentityUser> {
    const { User } = await translated(() =>
      this.client.send(
        new AdminCreateUserCommand({
          ...this.pool,
          Username: username,
          // Nothing is sent to the user: there may be nowhere to send it yet.
          MessageAction: 'SUPPRESS',
        }),
      ),
    );
    return {
      username: User?.Username ?? username,
      enabled: User?.Enabled ?? true,
      roles: [],
      createdAt: iso(User?.UserCreateDate),
    };
  }

  async setEnabled(username: string, enabled: boolean): Promise<void> {
    const input = { ...this.pool, Username: username };
    await translated(() =>
      enabled
        ? this.client.send(new AdminEnableUserCommand(input))
        : this.client.send(new AdminDisableUserCommand(input)),
    );
  }

  async deleteUser(username: string): Promise<void> {
    await translated(() =>
      this.client.send(
        new AdminDeleteUserCommand({ ...this.pool, Username: username }),
      ),
    );
  }

  async setPassword(
    username: string,
    password: string,
    options: { temporary?: boolean } = {},
  ): Promise<void> {
    await translated(() =>
      this.client.send(
        new AdminSetUserPasswordCommand({
          ...this.pool,
          Username: username,
          Password: password,
          Permanent: !(options.temporary ?? false),
        }),
      ),
    );
  }

  async grantRole(username: string, role: string): Promise<void> {
    await translated(() =>
      this.client.send(
        new AdminAddUserToGroupCommand({
          ...this.pool,
          Username: username,
          GroupName: role,
        }),
      ),
    );
  }

  async revokeRole(username: string, role: string): Promise<void> {
    try {
      await this.client.send(
        new AdminRemoveUserFromGroupCommand({
          ...this.pool,
          Username: username,
          GroupName: role,
        }),
      );
    } catch (error) {
      // A role that does not exist is not held, which is the outcome asked for.
      if ((error as { name?: string }).name === 'ResourceNotFoundException') {
        return;
      }
      await translated(() => Promise.reject(error));
    }
  }

  async signOutEverywhere(username: string): Promise<void> {
    await translated(() =>
      this.client.send(
        new AdminUserGlobalSignOutCommand({ ...this.pool, Username: username }),
      ),
    );
  }

  async changeOwnPassword(
    accessToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await translated(() =>
      this.client.send(
        new ChangePasswordCommand({
          AccessToken: accessToken,
          PreviousPassword: currentPassword,
          ProposedPassword: newPassword,
        }),
      ),
    );
  }

  async listOwnPasskeys(accessToken: string): Promise<Passkey[]> {
    const passkeys: Passkey[] = [];
    let NextToken: string | undefined;
    do {
      const page = await translated(() =>
        this.client.send(
          new ListWebAuthnCredentialsCommand({
            AccessToken: accessToken,
            NextToken,
          }),
        ),
      );
      for (const credential of page.Credentials ?? []) {
        if (!credential.CredentialId) continue;
        passkeys.push({
          id: credential.CredentialId,
          name: credential.FriendlyCredentialName ?? null,
          createdAt: iso(credential.CreatedAt),
        });
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return passkeys;
  }

  async removeOwnPasskey(accessToken: string, id: string): Promise<void> {
    await translated(() =>
      this.client.send(
        new DeleteWebAuthnCredentialCommand({
          AccessToken: accessToken,
          CredentialId: id,
        }),
      ),
    );
  }

  async ownAuthenticator(accessToken: string): Promise<{ enabled: boolean }> {
    const user = await translated(() =>
      this.client.send(new GetUserCommand({ AccessToken: accessToken })),
    );
    return {
      enabled: (user.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA'),
    };
  }

  async beginOwnAuthenticator(
    accessToken: string,
  ): Promise<{ secret: string }> {
    const answer = await translated(() =>
      this.client.send(
        new AssociateSoftwareTokenCommand({ AccessToken: accessToken }),
      ),
    );
    if (!answer.SecretCode) {
      throw new IdentityError('unsupported', MESSAGES.unsupported);
    }
    return { secret: answer.SecretCode };
  }

  async confirmOwnAuthenticator(
    accessToken: string,
    code: string,
  ): Promise<void> {
    const answer = await translated(() =>
      this.client.send(
        new VerifySoftwareTokenCommand({
          AccessToken: accessToken,
          UserCode: code,
        }),
      ),
    );
    if (answer.Status !== 'SUCCESS') {
      throw new IdentityError('invalidCode', MESSAGES.invalidCode);
    }
    // Verified is not yet asked for: that is said apart.
    await translated(() =>
      this.client.send(
        new SetUserMFAPreferenceCommand({
          AccessToken: accessToken,
          SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
        }),
      ),
    );
  }

  async removeOwnAuthenticator(accessToken: string): Promise<void> {
    await translated(() =>
      this.client.send(
        new SetUserMFAPreferenceCommand({
          AccessToken: accessToken,
          SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        }),
      ),
    );
  }
}
