import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  DirectoryError,
  type Account,
  type Directory,
} from '@mailless/directory';
import {
  IdentityError,
  TokenRefusedError,
  type IdentityProvider,
  type TokenVerifier,
} from '@mailless/identity';
import type { AppPasswordStore } from '@mailless/app-passwords';
import { HTTPException } from 'hono/http-exception';
import {
  AccountDetailSchema,
  AccountIdSchema,
  AccountSummarySchema,
  AddressSchema,
  AppPasswordSchema,
  ChangePasswordSchema,
  CreateAccountSchema,
  ErrorSchema,
  MeSchema,
  NewAppPasswordSchema,
  NewLabelSchema,
  PasskeySchema,
  AuthenticatorCodeSchema,
  AuthenticatorSchema,
  AuthenticatorSecretSchema,
  SetPasswordSchema,
  SetShareSchema,
  UpdateAccountSchema,
} from './schemas.js';

/*
 * The administration API. A signed-in user manages their own credentials
 * under /me; an administrator manages accounts under /accounts. It brings
 * together the directory (who has a mailbox), the identity provider (who may
 * sign in) and the app passwords mail clients use, and knows nothing of where
 * any of them is kept.
 */

export interface AuditEntry {
  /** Who did it. */
  actor: string;
  /** What was done, as the name of the operation. */
  action: string;
  /** The account it was done to. */
  account: string;
}

export interface AdminApiOptions {
  directory: Directory;
  identity: IdentityProvider;
  appPasswords: AppPasswordStore;
  /** Checks an access token and says whose it is and which roles they hold. */
  verifyToken: TokenVerifier;
  /** The role that lets a user manage accounts. */
  adminRole: string;
  /**
   * How full mailboxes are, when the host can tell: what an account's mail
   * takes up (null when it has not been counted yet) and how much an account
   * without a limit of its own may hold (null for no limit). Without it,
   * what a mailbox holds is unknown.
   */
  usage?: {
    usedOctets(accountId: string): Promise<number | null>;
    limitOctets: number | null;
  };
  /**
   * Asks for a closed account's mail to be removed, when the host can. It
   * need only take the request: the removal happens elsewhere, and whoever
   * does it deletes the account from the directory once nothing is left.
   * Without it, a closed account stays listed.
   */
  requestPurge?(accountId: string): Promise<void>;
  /** The identity provider's page for adding a passkey, when it has one. */
  passkeyEnrolmentUrl?: string;
  /**
   * Told of every change, for a record of who did what. Never given a
   * password, a secret or an address.
   */
  audit?(entry: AuditEntry): void;
  /** Told of failures that are not the caller's doing. */
  onError?(error: unknown): void;
}

interface Caller {
  username: string;
  isAdmin: boolean;
  /** The token they came with, for what the provider does on their behalf. */
  token: string;
}

type Env = { Variables: { caller: Caller } };

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 501,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS: Record<string, ApiError['status']> = {
  exists: 409,
  addressTaken: 409,
  notFound: 404,
  invalid: 400,
  invalidPassword: 422,
  invalidCode: 422,
  // The caller is signed in; it is what they offered (a current password) that was refused.
  notAuthorized: 403,
  rateLimited: 429,
  unsupported: 501,
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorSchema } },
});

/** The refusals any operation may answer with. */
const REFUSALS = {
  400: errorResponse('The request is not valid.'),
  401: errorResponse('Not signed in, or the token is not accepted.'),
  403: errorResponse('Signed in, but not allowed to do this.'),
};
const NOT_FOUND = { 404: errorResponse('There is no such account or item.') };

const json = <Schema extends z.ZodType>(
  schema: Schema,
  description: string,
) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = <Schema extends z.ZodType>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const NO_CONTENT = { 204: { description: 'Done.' } };
const security = [{ bearer: [] }];

const AccountParams = z.object({
  id: AccountIdSchema.openapi({ param: { name: 'id', in: 'path' } }),
});
const withParam = (name: string, schema: z.ZodString = z.string().min(1)) =>
  AccountParams.extend({
    [name]: schema.openapi({ param: { name, in: 'path' } }),
  });

export function createAdminApi(options: AdminApiOptions): OpenAPIHono<Env> {
  const { directory, identity, appPasswords, adminRole } = options;
  const audit = (caller: Caller, action: string, account: string) =>
    options.audit?.({ actor: caller.username, action, account });

  const app = new OpenAPIHono<Env>({
    defaultHook: (result) => {
      if (result.success) return;
      const issue = result.error.issues[0];
      const where = issue?.path.join('.') ?? '';
      throw new ApiError(
        400,
        'invalid',
        `${where ? `${where}: ` : ''}${issue?.message ?? 'not valid'}`,
      );
    },
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'An access token of the identity provider.',
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(
        { error: error.code, message: error.message },
        error.status,
      );
    }
    if (error instanceof DirectoryError || error instanceof IdentityError) {
      return c.json(
        { error: error.code, message: error.message },
        STATUS[error.code] ?? 400,
      );
    }
    if (error instanceof HTTPException) {
      // Hono's own refusals, such as a body that is not JSON.
      return c.json(
        { error: 'invalid', message: 'The request could not be read' },
        400,
      );
    }
    options.onError?.(error);
    return c.json({ error: 'failed', message: 'Something went wrong' }, 500);
  });
  app.notFound((c) =>
    c.json({ error: 'notFound', message: 'There is no such operation' }, 404),
  );

  // Everything needs a token. Who the caller is comes from it and from nothing else.
  app.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) throw new ApiError(401, 'unauthorized', 'Sign in first');
    try {
      const verified = await options.verifyToken(token);
      c.set('caller', {
        username: verified.username,
        isAdmin: verified.roles.includes(adminRole),
        token,
      });
    } catch (error) {
      if (!(error instanceof TokenRefusedError)) throw error;
      throw new ApiError(401, 'unauthorized', 'The token is not accepted');
    }
    await next();
  });

  // Managing accounts is for administrators.
  app.use('/accounts/*', async (c, next) => {
    if (!c.get('caller').isAdmin) {
      throw new ApiError(403, 'forbidden', 'Only an administrator may do this');
    }
    await next();
  });
  app.use('/accounts', async (c, next) => {
    if (!c.get('caller').isAdmin) {
      throw new ApiError(403, 'forbidden', 'Only an administrator may do this');
    }
    await next();
  });

  const requireAccount = async (id: string): Promise<Account> => {
    const account = await directory.account(id);
    if (!account) {
      throw new ApiError(404, 'notFound', `There is no account "${id}"`);
    }
    return account;
  };
  /** An administrator cannot lock themself out: someone else has to do that to them. */
  const notSelf = (caller: Caller, id: string, what: string) => {
    if (caller.username === id) {
      throw new ApiError(
        403,
        'forbidden',
        `You cannot ${what} yourself; another administrator can`,
      );
    }
  };

  const usageOf = async (account: Account) => ({
    usedOctets: (await options.usage?.usedOctets(account.id)) ?? null,
    // The account's own limit, or else the one every account gets.
    limitOctets: account.quotaOctets ?? options.usage?.limitOctets ?? null,
  });

  const detail = async (account: Account) => {
    const user = await identity.getUser(account.id);
    return {
      ...account,
      addresses: await directory.addressesOf(account.id),
      shares: await directory.sharesOf(account.id),
      sharedWith: await directory.sharedWith(account.id),
      canSignIn: user?.enabled ?? false,
      isAdmin: user?.roles.includes(adminRole) ?? false,
      usage: await usageOf(account),
    };
  };

  // ------------------------------------------------------------------- me

  app.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      operationId: 'getMe',
      tags: ['me'],
      summary: 'Who is signed in, and what they can do here',
      security,
      responses: { 200: json(MeSchema, 'The signed-in user.'), ...REFUSALS },
    }),
    async (c) => {
      const caller = c.get('caller');
      const account = (await directory.account(caller.username)) ?? null;
      return c.json(
        {
          username: caller.username,
          isAdmin: caller.isAdmin,
          account,
          addresses: account ? await directory.addressesOf(account.id) : [],
          usage: account ? await usageOf(account) : null,
          capabilities: identity.capabilities,
          passkeyEnrolmentUrl: options.passkeyEnrolmentUrl ?? null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/password',
      operationId: 'changeMyPassword',
      tags: ['me'],
      summary: 'Change the password of the signed-in user',
      security,
      request: { body: body(ChangePasswordSchema) },
      responses: {
        ...NO_CONTENT,
        ...REFUSALS,
        422: errorResponse('The new password does not meet the policy.'),
        429: errorResponse('Too many attempts.'),
        501: errorResponse('The identity provider cannot do this.'),
      },
    }),
    async (c) => {
      const caller = c.get('caller');
      if (!identity.capabilities.changeOwnPassword) {
        throw new ApiError(
          501,
          'unsupported',
          'Change the password with the identity provider',
        );
      }
      const { currentPassword, newPassword } = c.req.valid('json');
      await identity.changeOwnPassword(
        caller.token,
        currentPassword,
        newPassword,
      );
      audit(caller, 'changeMyPassword', caller.username);
      return c.body(null, 204);
    },
  );

  const requirePasskeys = () => {
    if (!identity.capabilities.manageOwnPasskeys) {
      throw new ApiError(
        501,
        'unsupported',
        'Manage passkeys with the identity provider',
      );
    }
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/passkeys',
      operationId: 'listMyPasskeys',
      tags: ['me'],
      summary: 'The passkeys of the signed-in user',
      security,
      responses: {
        200: json(z.array(PasskeySchema), 'Their passkeys.'),
        ...REFUSALS,
        501: errorResponse('The identity provider cannot do this.'),
      },
    }),
    async (c) => {
      requirePasskeys();
      return c.json(await identity.listOwnPasskeys(c.get('caller').token), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/me/passkeys/{passkeyId}',
      operationId: 'removeMyPasskey',
      tags: ['me'],
      summary: 'Remove a passkey of the signed-in user',
      security,
      request: {
        params: z.object({
          passkeyId: z
            .string()
            .min(1)
            .openapi({ param: { name: 'passkeyId', in: 'path' } }),
        }),
      },
      responses: {
        ...NO_CONTENT,
        ...REFUSALS,
        ...NOT_FOUND,
        501: errorResponse('The identity provider cannot do this.'),
      },
    }),
    async (c) => {
      requirePasskeys();
      const caller = c.get('caller');
      await identity.removeOwnPasskey(
        caller.token,
        c.req.valid('param').passkeyId,
      );
      audit(caller, 'removeMyPasskey', caller.username);
      return c.body(null, 204);
    },
  );

  const requireAuthenticator = () => {
    if (!identity.capabilities.manageOwnAuthenticator) {
      throw new ApiError(
        501,
        'unsupported',
        'Set up an authenticator app with the identity provider',
      );
    }
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/authenticator',
      operationId: 'getMyAuthenticator',
      tags: ['me'],
      summary:
        'Whether the signed-in user is asked for a code from an authenticator app',
      security,
      responses: {
        200: json(AuthenticatorSchema, 'Whether a code is asked for.'),
        ...REFUSALS,
        501: errorResponse('The identity provider cannot do this.'),
      },
    }),
    async (c) => {
      requireAuthenticator();
      return c.json(
        await identity.ownAuthenticator(c.get('caller').token),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/authenticator',
      operationId: 'beginMyAuthenticator',
      tags: ['me'],
      summary: 'Start setting up an authenticator app',
      description:
        'Gives the secret to put in the app. Nothing is asked for at sign-in until a code made from it is confirmed.',
      security,
      responses: {
        200: json(AuthenticatorSecretSchema, 'The secret, shown once.'),
        ...REFUSALS,
        429: errorResponse('Too many attempts.'),
        501: errorResponse('The identity provider cannot do this.'),
      },
    }),
    async (c) => {
      requireAuthenticator();
      const caller = c.get('caller');
      const { secret } = await identity.beginOwnAuthenticator(caller.token);
      audit(caller, 'beginMyAuthenticator', caller.username);
      return c.json({ secret }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/authenticator/confirm',
      operationId: 'confirmMyAuthenticator',
      tags: ['me'],
      summary: 'Finish setting up an authenticator app',
      description:
        'From now on a code from the app is asked for after the password, at every sign-in.',
      security,
      request: { body: body(AuthenticatorCodeSchema) },
      responses: {
        ...NO_CONTENT,
        ...REFUSALS,
        422: errorResponse('The code is not the one the app shows now.'),
        429: errorResponse('Too many attempts.'),
        501: errorResponse('The identity provider cannot do this.'),
      },
    }),
    async (c) => {
      requireAuthenticator();
      const caller = c.get('caller');
      await identity.confirmOwnAuthenticator(
        caller.token,
        c.req.valid('json').code,
      );
      audit(caller, 'confirmMyAuthenticator', caller.username);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/me/authenticator',
      operationId: 'removeMyAuthenticator',
      tags: ['me'],
      summary: 'Stop asking the signed-in user for a code',
      security,
      responses: {
        ...NO_CONTENT,
        ...REFUSALS,
        501: errorResponse('The identity provider cannot do this.'),
      },
    }),
    async (c) => {
      requireAuthenticator();
      const caller = c.get('caller');
      await identity.removeOwnAuthenticator(caller.token);
      audit(caller, 'removeMyAuthenticator', caller.username);
      return c.body(null, 204);
    },
  );

  /** App passwords open a mailbox, so they are for users who have one. */
  const requireOwnMailbox = async (caller: Caller): Promise<string> => {
    const account = await directory.account(caller.username);
    if (account?.status !== 'active') {
      throw new ApiError(
        403,
        'forbidden',
        'App passwords are for users with a mailbox in use',
      );
    }
    return account.id;
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/app-passwords',
      operationId: 'listMyAppPasswords',
      tags: ['me'],
      summary: 'The app passwords of the signed-in user, without their secrets',
      security,
      responses: {
        200: json(z.array(AppPasswordSchema), 'Their app passwords.'),
        ...REFUSALS,
      },
    }),
    async (c) =>
      c.json(
        await appPasswords.list(await requireOwnMailbox(c.get('caller'))),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/me/app-passwords',
      operationId: 'createMyAppPassword',
      tags: ['me'],
      summary: 'Make a password for one mail app; it is shown once',
      security,
      request: { body: body(NewLabelSchema) },
      responses: {
        201: json(NewAppPasswordSchema, 'The new password, with its secret.'),
        ...REFUSALS,
      },
    }),
    async (c) => {
      const caller = c.get('caller');
      const accountId = await requireOwnMailbox(caller);
      let created;
      try {
        created = await appPasswords.create(
          accountId,
          c.req.valid('json').label,
        );
      } catch (error) {
        throw new ApiError(400, 'invalid', (error as Error).message);
      }
      audit(caller, 'createMyAppPassword', accountId);
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/me/app-passwords/{appPasswordId}',
      operationId: 'revokeMyAppPassword',
      tags: ['me'],
      summary: 'Revoke an app password of the signed-in user',
      security,
      request: {
        params: z.object({
          appPasswordId: z
            .string()
            .min(1)
            .openapi({ param: { name: 'appPasswordId', in: 'path' } }),
        }),
      },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const accountId = await requireOwnMailbox(caller);
      if (
        !(await appPasswords.revoke(
          accountId,
          c.req.valid('param').appPasswordId,
        ))
      ) {
        throw new ApiError(404, 'notFound', 'There is no such app password');
      }
      audit(caller, 'revokeMyAppPassword', accountId);
      return c.body(null, 204);
    },
  );

  // ------------------------------------------------------------- accounts

  app.openapi(
    createRoute({
      method: 'get',
      path: '/accounts',
      operationId: 'listAccounts',
      tags: ['accounts'],
      summary: 'Every account, with how full its mailbox is',
      security,
      responses: {
        200: json(z.array(AccountSummarySchema), 'The accounts, by id.'),
        ...REFUSALS,
      },
    }),
    async (c) =>
      c.json(
        await Promise.all(
          (await directory.listAccounts()).map(async (account) => ({
            ...account,
            usage: await usageOf(account),
          })),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/accounts',
      operationId: 'createAccount',
      tags: ['accounts'],
      summary:
        'Make an account and its user, who cannot sign in until given a password',
      security,
      request: { body: body(CreateAccountSchema) },
      responses: {
        201: json(AccountDetailSchema, 'The new account.'),
        ...REFUSALS,
        409: errorResponse('The id is taken.'),
      },
    }),
    async (c) => {
      const caller = c.get('caller');
      const input = c.req.valid('json');
      const account = await directory.createAccount({
        id: input.id,
        name: input.name ?? null,
      });
      try {
        await identity.createUser(account.id);
      } catch (error) {
        // A user of that name may be there already, from before the directory was.
        if (!(error instanceof IdentityError && error.code === 'exists')) {
          await directory.deleteAccount(account.id);
          throw error;
        }
      }
      audit(caller, 'createAccount', account.id);
      return c.json(await detail(account), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/{id}',
      operationId: 'getAccount',
      tags: ['accounts'],
      summary: 'One account, with its addresses and who it is shared with',
      security,
      request: { params: AccountParams },
      responses: {
        200: json(AccountDetailSchema, 'The account.'),
        ...REFUSALS,
        ...NOT_FOUND,
      },
    }),
    async (c) =>
      c.json(await detail(await requireAccount(c.req.valid('param').id)), 200),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/accounts/{id}',
      operationId: 'updateAccount',
      tags: ['accounts'],
      summary: 'Rename an account, or switch it off and on',
      description:
        'A disabled account cannot be signed in to, by password, passkey or app password. Mail for it still arrives.',
      security,
      request: { params: AccountParams, body: body(UpdateAccountSchema) },
      responses: {
        200: json(AccountDetailSchema, 'The account as it is now.'),
        ...REFUSALS,
        ...NOT_FOUND,
      },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id } = c.req.valid('param');
      const changes = c.req.valid('json');
      const account = await requireAccount(id);
      if (account.status === 'deleting') {
        throw new ApiError(403, 'forbidden', 'The account is being deleted');
      }
      if (changes.status === 'disabled') notSelf(caller, id, 'disable');

      if (changes.status && changes.status !== account.status) {
        const enabled = changes.status === 'active';
        if (await identity.getUser(id)) {
          await identity.setEnabled(id, enabled);
          if (!enabled) await identity.signOutEverywhere(id);
        }
        audit(caller, enabled ? 'enableAccount' : 'disableAccount', id);
      }
      const updated = await directory.updateAccount(id, {
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.status ? { status: changes.status } : {}),
        ...(changes.quotaOctets !== undefined
          ? { quotaOctets: changes.quotaOctets }
          : {}),
      });
      if (
        changes.quotaOctets !== undefined &&
        changes.quotaOctets !== account.quotaOctets
      ) {
        audit(caller, 'setQuota', id);
      }
      if (changes.name !== undefined && changes.name !== account.name) {
        audit(caller, 'renameAccount', id);
      }
      return c.json(await detail(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/accounts/{id}',
      operationId: 'deleteAccount',
      tags: ['accounts'],
      summary: 'Close an account permanently',
      description:
        'The user can no longer sign in, the addresses stop delivering, the app passwords are revoked and the account is no longer shared. Its mail is then removed, which takes a few minutes or more; until that is done the account stays listed as "deleting", so that its id cannot be given to someone else while its mail still exists. Closing an account that is already "deleting" asks for the removal again.',
      security,
      request: { params: AccountParams },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id } = c.req.valid('param');
      await requireAccount(id);
      notSelf(caller, id, 'delete');

      // First what stops it being used, so that a failure half-way leaves it closed rather than open.
      await directory.updateAccount(id, { status: 'deleting' });
      if (await identity.getUser(id)) await identity.deleteUser(id);
      for (const password of await appPasswords.list(id)) {
        await appPasswords.revoke(id, password.id);
      }
      for (const address of await directory.addressesOf(id)) {
        await directory.removeAddress(id, address);
      }
      for (const user of Object.keys(await directory.sharesOf(id))) {
        await directory.removeShare(id, user);
      }
      for (const account of Object.keys(await directory.sharedWith(id))) {
        await directory.removeShare(account, id);
      }
      audit(caller, 'deleteAccount', id);
      // Last, and after the record of it: the account is closed whether or not this is taken.
      await options.requestPurge?.(id);
      return c.body(null, 204);
    },
  );

  /** An account that can still be changed: one that exists and is not on its way out. */
  const requireOpenAccount = async (id: string): Promise<Account> => {
    const account = await requireAccount(id);
    if (account.status === 'deleting') {
      throw new ApiError(403, 'forbidden', 'The account is being deleted');
    }
    return account;
  };

  app.openapi(
    createRoute({
      method: 'post',
      path: '/accounts/{id}/password',
      operationId: 'setAccountPassword',
      tags: ['accounts'],
      summary:
        'Give a user a password, for a new user or one who is locked out',
      security,
      request: { params: AccountParams, body: body(SetPasswordSchema) },
      responses: {
        ...NO_CONTENT,
        ...REFUSALS,
        ...NOT_FOUND,
        422: errorResponse('The password does not meet the policy.'),
      },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id } = c.req.valid('param');
      const { password, temporary } = c.req.valid('json');
      await requireOpenAccount(id);
      await identity.setPassword(id, password, { temporary });
      audit(caller, 'setAccountPassword', id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/accounts/{id}/sign-out',
      operationId: 'signOutAccount',
      tags: ['accounts'],
      summary: 'End every session of a user, for when a device is lost',
      description: 'App passwords are not sessions: revoke those separately.',
      security,
      request: { params: AccountParams },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id } = c.req.valid('param');
      await requireAccount(id);
      await identity.signOutEverywhere(id);
      audit(caller, 'signOutAccount', id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/accounts/{id}/admin',
      operationId: 'grantAdmin',
      tags: ['accounts'],
      summary: 'Let a user manage accounts',
      security,
      request: { params: AccountParams },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id } = c.req.valid('param');
      await requireOpenAccount(id);
      await identity.grantRole(id, adminRole);
      audit(caller, 'grantAdmin', id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/accounts/{id}/admin',
      operationId: 'revokeAdmin',
      tags: ['accounts'],
      summary: 'Stop a user managing accounts, and end their sessions',
      security,
      request: { params: AccountParams },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id } = c.req.valid('param');
      await requireAccount(id);
      notSelf(caller, id, 'take the administrator role from');
      await identity.revokeRole(id, adminRole);
      // The role is in the tokens they already hold.
      await identity.signOutEverywhere(id);
      audit(caller, 'revokeAdmin', id);
      return c.body(null, 204);
    },
  );

  const AddressParams = withParam('address', AddressSchema);

  app.openapi(
    createRoute({
      method: 'put',
      path: '/accounts/{id}/addresses/{address}',
      operationId: 'addAddress',
      tags: ['accounts'],
      summary: 'Deliver an address, or a whole domain, to an account',
      security,
      request: { params: AddressParams },
      responses: {
        ...NO_CONTENT,
        ...REFUSALS,
        ...NOT_FOUND,
        409: errorResponse('The address delivers to another account.'),
      },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id, address } = c.req.valid('param');
      await requireOpenAccount(id);
      await directory.addAddress(id, address);
      audit(caller, 'addAddress', id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/accounts/{id}/addresses/{address}',
      operationId: 'removeAddress',
      tags: ['accounts'],
      summary: 'Stop delivering an address to an account',
      security,
      request: { params: AddressParams },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id, address } = c.req.valid('param');
      await requireAccount(id);
      if (!(await directory.removeAddress(id, address))) {
        throw new ApiError(
          404,
          'notFound',
          'The address does not deliver to this account',
        );
      }
      audit(caller, 'removeAddress', id);
      return c.body(null, 204);
    },
  );

  const ShareParams = withParam('user', AccountIdSchema);

  app.openapi(
    createRoute({
      method: 'put',
      path: '/accounts/{id}/shares/{user}',
      operationId: 'setShare',
      tags: ['accounts'],
      summary:
        'Let another user use an account, to change it or only to read it',
      security,
      request: { params: ShareParams, body: body(SetShareSchema) },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id, user } = c.req.valid('param');
      await requireOpenAccount(id);
      await directory.setShare(id, user, c.req.valid('json').access);
      audit(caller, 'setShare', id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/accounts/{id}/shares/{user}',
      operationId: 'removeShare',
      tags: ['accounts'],
      summary: 'Stop sharing an account with a user',
      security,
      request: { params: ShareParams },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id, user } = c.req.valid('param');
      await requireAccount(id);
      if (!(await directory.removeShare(id, user))) {
        throw new ApiError(
          404,
          'notFound',
          'The account is not shared with that user',
        );
      }
      audit(caller, 'removeShare', id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/{id}/app-passwords',
      operationId: 'listAccountAppPasswords',
      tags: ['accounts'],
      summary: 'The app passwords of an account, without their secrets',
      security,
      request: { params: AccountParams },
      responses: {
        200: json(z.array(AppPasswordSchema), 'Its app passwords.'),
        ...REFUSALS,
        ...NOT_FOUND,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      await requireAccount(id);
      return c.json(await appPasswords.list(id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/accounts/{id}/app-passwords/{appPasswordId}',
      operationId: 'revokeAccountAppPassword',
      tags: ['accounts'],
      summary:
        'Revoke an app password of an account, for when a device is lost',
      security,
      request: { params: withParam('appPasswordId') },
      responses: { ...NO_CONTENT, ...REFUSALS, ...NOT_FOUND },
    }),
    async (c) => {
      const caller = c.get('caller');
      const { id, appPasswordId } = c.req.valid('param');
      await requireAccount(id);
      if (!(await appPasswords.revoke(id, appPasswordId))) {
        throw new ApiError(404, 'notFound', 'There is no such app password');
      }
      audit(caller, 'revokeAccountAppPassword', id);
      return c.body(null, 204);
    },
  );

  return app;
}

/** The OpenAPI document of the API, as it is served under `basePath`. */
export function adminApiDocument(basePath = '/admin/api'): object {
  // Nothing is called to describe the API, so nothing real needs to be behind it.
  const unused = new Proxy(
    {},
    {
      get() {
        throw new Error('The API is only being described');
      },
    },
  );
  const app = createAdminApi({
    directory: unused as Directory,
    identity: unused as IdentityProvider,
    appPasswords: unused as AppPasswordStore,
    verifyToken: unused as unknown as TokenVerifier,
    adminRole: '',
  });
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'mailless administration API',
      version: '1',
      description:
        'Accounts, addresses and shares for administrators, and each user’s own password, passkeys and app passwords. Every call needs an access token of the identity provider as a bearer token.',
    },
    servers: [{ url: basePath }],
    tags: [
      { name: 'me', description: 'What a signed-in user does for themself.' },
      {
        name: 'accounts',
        description:
          'What an administrator does. Needs the administrator role.',
      },
    ],
  });
}
