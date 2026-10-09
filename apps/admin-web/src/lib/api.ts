import {
  addAddress,
  beginMyAuthenticator,
  changeMyPassword,
  confirmMyAuthenticator,
  createAccount,
  createAdminClient,
  createMyAppPassword,
  deleteAccount,
  getAccount,
  getMe,
  getMyAuthenticator,
  grantAdmin,
  listAccountAppPasswords,
  listAccounts,
  listMyAppPasswords,
  listMyPasskeys,
  removeAddress,
  removeMyAuthenticator,
  removeMyPasskey,
  removeShare,
  revokeAccountAppPassword,
  revokeAdmin,
  revokeMyAppPassword,
  setAccountPassword,
  setShare,
  signOutAccount,
  updateAccount,
  type ChangePassword,
  type CreateAccount,
  type SetPassword,
  type ShareAccess,
  type UpdateAccount,
} from '@mailless/admin-client';
import type { Session } from '@mailless/web-session';

/** A call the API refused, or that did not get through. `code` is the API's word for why. */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

interface Outcome<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

function failureFrom(outcome: Outcome<unknown>): ApiFailure {
  const status = outcome.response?.status ?? 0;
  const body = outcome.error;
  if (typeof body === 'object' && body !== null) {
    const { error, message } = body as { error?: unknown; message?: unknown };
    if (typeof error === 'string' && typeof message === 'string') {
      return new ApiFailure(error, message, status);
    }
  }
  return new ApiFailure(
    status === 0 ? 'unreachable' : 'failed',
    status === 0
      ? 'The server could not be reached. Check your connection and try again.'
      : 'Something went wrong. Please try again.',
    status,
  );
}

/**
 * Every operation of the administration API, as a function that gives the
 * answer or throws an ApiFailure. A call that is refused because the token
 * ran out is tried once more with a fresh one; if that is refused too, the
 * user is signed out here.
 */
export function createApi(
  session: Session,
  baseUrl: string,
  fetcher?: typeof fetch,
) {
  const client = createAdminClient({
    baseUrl,
    token: () => session.accessToken(),
    ...(fetcher ? { fetch: fetcher } : {}),
  });

  async function attempt<T>(
    call: () => Promise<Outcome<T>>,
  ): Promise<Outcome<T>> {
    try {
      return await call();
    } catch {
      // The request never got an answer.
      return {};
    }
  }

  async function run<T>(call: () => Promise<Outcome<T>>): Promise<T> {
    let outcome = await attempt(call);
    if (outcome.response?.status === 401) {
      if (await session.renew()) outcome = await attempt(call);
      if (outcome.response?.status === 401) {
        session.forget();
        throw new ApiFailure(
          'unauthorized',
          'You have been signed out. Please sign in again.',
          401,
        );
      }
    }
    if (!outcome.response?.ok) throw failureFrom(outcome);
    return outcome.data as T;
  }

  return {
    me: () => run(() => getMe({ client })),
    changeMyPassword: (body: ChangePassword) =>
      run(() => changeMyPassword({ client, body })),
    myPasskeys: () => run(() => listMyPasskeys({ client })),
    removeMyPasskey: (passkeyId: string) =>
      run(() => removeMyPasskey({ client, path: { passkeyId } })),
    myAuthenticator: () => run(() => getMyAuthenticator({ client })),
    beginMyAuthenticator: () => run(() => beginMyAuthenticator({ client })),
    confirmMyAuthenticator: (code: string) =>
      run(() => confirmMyAuthenticator({ client, body: { code } })),
    removeMyAuthenticator: () => run(() => removeMyAuthenticator({ client })),
    myAppPasswords: () => run(() => listMyAppPasswords({ client })),
    createMyAppPassword: (label: string) =>
      run(() => createMyAppPassword({ client, body: { label } })),
    revokeMyAppPassword: (appPasswordId: string) =>
      run(() => revokeMyAppPassword({ client, path: { appPasswordId } })),

    accounts: () => run(() => listAccounts({ client })),
    createAccount: (body: CreateAccount) =>
      run(() => createAccount({ client, body })),
    account: (id: string) => run(() => getAccount({ client, path: { id } })),
    updateAccount: (id: string, body: UpdateAccount) =>
      run(() => updateAccount({ client, path: { id }, body })),
    closeAccount: (id: string) =>
      run(() => deleteAccount({ client, path: { id } })),
    setAccountPassword: (id: string, body: SetPassword) =>
      run(() => setAccountPassword({ client, path: { id }, body })),
    signOutAccount: (id: string) =>
      run(() => signOutAccount({ client, path: { id } })),
    grantAdmin: (id: string) => run(() => grantAdmin({ client, path: { id } })),
    revokeAdmin: (id: string) =>
      run(() => revokeAdmin({ client, path: { id } })),
    addAddress: (id: string, address: string) =>
      run(() => addAddress({ client, path: { id, address } })),
    removeAddress: (id: string, address: string) =>
      run(() => removeAddress({ client, path: { id, address } })),
    setShare: (id: string, user: string, access: ShareAccess) =>
      run(() => setShare({ client, path: { id, user }, body: { access } })),
    removeShare: (id: string, user: string) =>
      run(() => removeShare({ client, path: { id, user } })),
    accountAppPasswords: (id: string) =>
      run(() => listAccountAppPasswords({ client, path: { id } })),
    revokeAccountAppPassword: (id: string, appPasswordId: string) =>
      run(() =>
        revokeAccountAppPassword({ client, path: { id, appPasswordId } }),
      ),
  };
}

export type Api = ReturnType<typeof createApi>;

/** What to tell the user about a failed call. */
export function failureMessage(error: unknown): string {
  return error instanceof ApiFailure
    ? error.message
    : 'Something went wrong. Please try again.';
}
