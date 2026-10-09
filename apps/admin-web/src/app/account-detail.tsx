import { useState, type FormEvent } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { AccountDetail, Me, ShareAccess } from '@mailless/admin-client';
import { ApiFailure } from '../lib/api';
import { ACCOUNT_ID_PATTERN } from './accounts';
import {
  ConfirmButton,
  LoadError,
  Loading,
  Notice,
  Section,
  StatusBadge,
  Usage,
  formatDate,
  formatSize,
} from './components';
import { useServices } from './services';

const ACCESS_TEXT: Record<ShareAccess, string> = {
  member: 'May read and change',
  reader: 'May only read',
};

/** A change to one account: runs it, then reads the account again. */
function useAccountChange<Input = void>(
  id: string,
  change: (input: Input) => Promise<unknown>,
): UseMutationResult<unknown, Error, Input> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: change,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['account', id] }),
        queryClient.invalidateQueries({ queryKey: ['accounts'] }),
      ]),
  });
}

export function AccountDetailPage({ me }: { me: Me }) {
  const { api } = useServices();
  const { id = '' } = useParams();
  const account = useQuery({
    queryKey: ['account', id],
    queryFn: () => api.account(id),
    retry: false,
  });

  const back = (
    <p>
      <Link to="/accounts">← All accounts</Link>
    </p>
  );
  if (account.isPending) {
    return (
      <>
        {back}
        <Loading what="the account" />
      </>
    );
  }
  if (account.isError) {
    const missing =
      account.error instanceof ApiFailure && account.error.status === 404;
    return (
      <>
        {back}
        {missing ? (
          <>
            <h1>No such account</h1>
            <p className="muted">
              There is no account “{id}”. It may have been mistyped.
            </p>
          </>
        ) : (
          <LoadError
            error={account.error}
            onRetry={() => void account.refetch()}
          />
        )}
      </>
    );
  }

  const data = account.data;
  const isSelf = me.username === data.id;
  const closed = data.status === 'deleting';
  return (
    <>
      {back}
      <h1>
        {data.id} <StatusBadge status={data.status} />
      </h1>
      {closed ? (
        <p className="notice notice-warning">
          This account is closed. Nobody can sign in to it and no mail is
          delivered to it. Its mail is being removed; once that is done the
          account leaves this list and its id can be used again.
        </p>
      ) : null}
      <Summary account={data} />
      {closed ? null : (
        <>
          <Rename account={data} />
          <Quota account={data} />
          <Addresses account={data} />
          <Shares account={data} />
          <SignIn account={data} isSelf={isSelf} />
        </>
      )}
      <AccountAppPasswords id={data.id} readOnly={closed} />
      {closed ? (
        <RemoveMailAgain account={data} />
      ) : (
        <CloseAccount account={data} isSelf={isSelf} />
      )}
    </>
  );
}

function Summary({ account }: { account: AccountDetail }) {
  const sharedWith = Object.entries(account.sharedWith);
  return (
    <Section title="Overview">
      <dl className="facts">
        <dt>Name</dt>
        <dd>{account.name ?? <span className="muted">Not set</span>}</dd>
        <dt>Created</dt>
        <dd>{formatDate(account.createdAt)}</dd>
        <dt>Can sign in</dt>
        <dd>{account.canSignIn ? 'Yes' : 'No'}</dd>
        <dt>Role</dt>
        <dd>{account.isAdmin ? 'Administrator' : 'User'}</dd>
        <dt>Mailbox</dt>
        <dd>
          <Usage usage={account.usage} />
        </dd>
      </dl>
      {sharedWith.length > 0 ? (
        <>
          <h3>Other accounts this user may use</h3>
          <ul className="plain-list">
            {sharedWith.map(([other, access]) => (
              <li key={other}>
                <Link to={`/accounts/${other}`}>{other}</Link>{' '}
                <span className="muted">· {ACCESS_TEXT[access]}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

function Rename({ account }: { account: AccountDetail }) {
  const { api } = useServices();
  const [name, setName] = useState(account.name ?? '');
  const rename = useAccountChange(account.id, () =>
    api.updateAccount(account.id, {
      name: name.trim() === '' ? null : name.trim(),
    }),
  );
  return (
    <Section
      title="Name"
      description="Shown as the sender of the account’s mail."
    >
      <form
        className="form form-inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          rename.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="account-name">Name</label>
          <input
            id="account-name"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <button type="submit" className="button" disabled={rename.isPending}>
          Save name
        </button>
      </form>
      <Notice
        error={rename.error}
        success={rename.isSuccess ? 'The name was saved.' : null}
      />
    </Section>
  );
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** How much mail the account may hold: a limit of its own, or what every account gets. */
function Quota({ account }: { account: AccountDetail }) {
  const { api } = useServices();
  const own = account.quotaOctets;
  // Shown in whole gigabytes when it is that, in megabytes otherwise.
  const inGb = own !== null && own % GB === 0;
  const [amount, setAmount] = useState(
    own === null ? '' : String(inGb ? own / GB : Math.round(own / MB)),
  );
  const [unit, setUnit] = useState<'MB' | 'GB'>(
    own === null || inGb ? 'GB' : 'MB',
  );
  const save = useAccountChange(account.id, (quotaOctets: number | null) =>
    api.updateAccount(account.id, { quotaOctets }),
  );
  const octets = Math.round(Number(amount) * (unit === 'GB' ? GB : MB));
  const valid = amount.trim() !== '' && Number.isFinite(octets) && octets >= MB;
  // Without a limit of its own, what the account is held to is what all are.
  const shared = account.usage.limitOctets;
  return (
    <Section
      title="Mailbox size"
      description="How much mail the account may hold. Mail arriving from outside is always delivered; what the user adds themself is refused once the mailbox is full."
    >
      <p>
        {own === null
          ? shared === null
            ? 'This account has no limit of its own, and accounts without one have no limit.'
            : `This account has no limit of its own, so it gets what every account gets: ${formatSize(shared)}.`
          : `This account has a limit of its own: ${formatSize(own)}.`}
      </p>
      <form
        className="form form-inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (valid) save.mutate(octets);
        }}
      >
        <div className="field">
          <label htmlFor="account-quota">Limit</label>
          <input
            id="account-quota"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="account-quota-unit">Unit</label>
          <select
            id="account-quota-unit"
            value={unit}
            onChange={(event) => setUnit(event.target.value as 'MB' | 'GB')}
          >
            <option value="MB">MB</option>
            <option value="GB">GB</option>
          </select>
        </div>
        <button
          type="submit"
          className="button"
          disabled={!valid || save.isPending}
        >
          Save limit
        </button>
        {own === null ? null : (
          <button
            type="button"
            className="button"
            disabled={save.isPending}
            onClick={() => {
              setAmount('');
              save.mutate(null);
            }}
          >
            Remove its own limit
          </button>
        )}
      </form>
      {amount.trim() !== '' && !valid ? (
        <p className="hint">A limit is at least 1 MB.</p>
      ) : null}
      <Notice
        error={save.error}
        success={save.isSuccess ? 'The limit was saved.' : null}
      />
    </Section>
  );
}

function Addresses({ account }: { account: AccountDetail }) {
  const { api } = useServices();
  const [address, setAddress] = useState('');
  const add = useAccountChange(account.id, (value: string) =>
    api.addAddress(account.id, value),
  );
  const remove = useAccountChange(account.id, (value: string) =>
    api.removeAddress(account.id, value),
  );
  return (
    <Section
      title="Addresses"
      description="Mail sent to these addresses is delivered to this account, and the account may send from them."
    >
      {account.addresses.length === 0 ? (
        <p className="muted">
          No address delivers here, so this account gets no mail.
        </p>
      ) : (
        <ul className="rows">
          {account.addresses.map((value) => (
            <li key={value} className="row">
              <div>
                <code>{value}</code>
                {value.startsWith('*@') ? (
                  <div className="muted small">
                    Every address at {value.slice(2)} that no other account has.
                  </div>
                ) : null}
              </div>
              <ConfirmButton
                label="Remove"
                title="Remove this address?"
                confirmLabel="Remove address"
                danger
                disabled={remove.isPending}
                onConfirm={() => {
                  add.reset();
                  remove.mutate(value);
                }}
              >
                <p>
                  Mail for <strong>{value}</strong> will no longer be delivered
                  to {account.id}.
                </p>
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="form form-inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          remove.reset();
          add.mutate(address.trim(), { onSuccess: () => setAddress('') });
        }}
      >
        <div className="field">
          <label htmlFor="new-address">Add an address</label>
          <input
            id="new-address"
            required
            placeholder="name@example.com"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="new-address-hint"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <p id="new-address-hint" className="hint">
            Use <code>*@example.com</code> for every address at a domain that no
            other account has.
          </p>
        </div>
        <button
          type="submit"
          className="button button-primary"
          disabled={add.isPending}
        >
          Add address
        </button>
      </form>
      <Notice
        error={add.error ?? remove.error}
        success={
          add.isSuccess
            ? 'The address was added.'
            : remove.isSuccess
              ? 'The address was removed.'
              : null
        }
      />
    </Section>
  );
}

function Shares({ account }: { account: AccountDetail }) {
  const { api } = useServices();
  const [user, setUser] = useState('');
  const [access, setAccess] = useState<ShareAccess>('member');
  const share = useAccountChange(
    account.id,
    (input: { user: string; access: ShareAccess }) =>
      api.setShare(account.id, input.user, input.access),
  );
  const unshare = useAccountChange(account.id, (value: string) =>
    api.removeShare(account.id, value),
  );
  const shares = Object.entries(account.shares);
  return (
    <Section
      title="Shared with"
      description="Other users who may use this account next to their own, such as a mailbox a team shares."
    >
      {shares.length === 0 ? (
        <p className="muted">This account is not shared with anyone.</p>
      ) : (
        <ul className="rows">
          {shares.map(([other, level]) => (
            <li key={other} className="row">
              <div>
                <Link to={`/accounts/${other}`}>{other}</Link>
                <div className="muted small">{ACCESS_TEXT[level]}</div>
              </div>
              <ConfirmButton
                label="Stop sharing"
                title="Stop sharing with this user?"
                confirmLabel="Stop sharing"
                danger
                disabled={unshare.isPending}
                onConfirm={() => {
                  share.reset();
                  unshare.mutate(other);
                }}
              >
                <p>
                  <strong>{other}</strong> will no longer see {account.id} in
                  their mail app.
                </p>
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <form
        className="form form-inline"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          unshare.reset();
          share.mutate({ user, access }, { onSuccess: () => setUser('') });
        }}
      >
        <div className="field">
          <label htmlFor="share-user">Share with user</label>
          <input
            id="share-user"
            required
            pattern={ACCOUNT_ID_PATTERN}
            placeholder="Account id"
            autoCapitalize="none"
            spellCheck={false}
            value={user}
            onChange={(event) => setUser(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="share-access">Access</label>
          <select
            id="share-access"
            value={access}
            onChange={(event) => setAccess(event.target.value as ShareAccess)}
          >
            <option value="member">Read and change</option>
            <option value="reader">Read only</option>
          </select>
        </div>
        <button
          type="submit"
          className="button button-primary"
          disabled={share.isPending}
        >
          Share
        </button>
      </form>
      <Notice
        error={share.error ?? unshare.error}
        success={
          share.isSuccess
            ? 'The account is now shared.'
            : unshare.isSuccess
              ? 'Sharing was stopped.'
              : null
        }
      />
    </Section>
  );
}

function SignIn({
  account,
  isSelf,
}: {
  account: AccountDetail;
  isSelf: boolean;
}) {
  const { api } = useServices();
  const id = account.id;
  const [password, setPassword] = useState('');
  const [temporary, setTemporary] = useState(true);
  const setPasswordChange = useAccountChange(id, () =>
    api.setAccountPassword(id, { password, temporary }),
  );
  const status = useAccountChange(id, (next: 'active' | 'disabled') =>
    api.updateAccount(id, { status: next }),
  );
  const signOut = useAccountChange(id, () => api.signOutAccount(id));
  const admin = useAccountChange(id, (grant: boolean) =>
    grant ? api.grantAdmin(id) : api.revokeAdmin(id),
  );
  const changes = [setPasswordChange, status, signOut, admin];
  const only = (kept: { reset(): void }) => {
    for (const change of changes) if (change !== kept) change.reset();
  };
  const disabled = account.status === 'disabled';
  const ownAccountHint = (
    <p className="hint">
      This is your own account. Another administrator has to do this.
    </p>
  );

  return (
    <Section title="Sign-in">
      <form
        className="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          only(setPasswordChange);
          setPasswordChange.mutate(undefined, {
            onSuccess: () => setPassword(''),
          });
        }}
      >
        <h3>Set a password</h3>
        <p className="muted">
          For a new user, or one who is locked out. Tell them the password
          yourself; nothing is sent to them.
        </p>
        <div className="field">
          <label htmlFor="set-password">New password</label>
          <input
            id="set-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={temporary}
            onChange={(event) => setTemporary(event.target.checked)}
          />
          Temporary: they must choose their own when they first sign in
        </label>
        <div className="actions">
          <button
            type="submit"
            className="button"
            disabled={setPasswordChange.isPending}
          >
            Set password
          </button>
        </div>
      </form>

      <h3>Sessions</h3>
      <p className="muted">
        Ends everywhere this user is signed in, for when a device is lost. App
        passwords keep working until you revoke them below.
      </p>
      <div className="actions">
        <ConfirmButton
          label="End all sessions"
          title="End all sessions?"
          confirmLabel="End all sessions"
          disabled={signOut.isPending}
          onConfirm={() => {
            only(signOut);
            signOut.mutate();
          }}
        >
          <p>
            <strong>{id}</strong> will have to sign in again everywhere.
          </p>
        </ConfirmButton>
      </div>

      <h3>Administrator</h3>
      <p className="muted">
        {account.isAdmin
          ? 'This user may manage accounts.'
          : 'This user may not manage accounts.'}
      </p>
      <div className="actions">
        {account.isAdmin ? (
          <ConfirmButton
            label="Remove administrator role"
            title="Remove the administrator role?"
            confirmLabel="Remove role"
            danger
            disabled={isSelf || admin.isPending}
            onConfirm={() => {
              only(admin);
              admin.mutate(false);
            }}
          >
            <p>
              <strong>{id}</strong> will no longer manage accounts, and will be
              signed out everywhere.
            </p>
          </ConfirmButton>
        ) : (
          <ConfirmButton
            label="Make administrator"
            title="Make this user an administrator?"
            confirmLabel="Make administrator"
            disabled={admin.isPending}
            onConfirm={() => {
              only(admin);
              admin.mutate(true);
            }}
          >
            <p>
              <strong>{id}</strong> will be able to manage every account. It
              takes effect the next time they sign in.
            </p>
          </ConfirmButton>
        )}
      </div>
      {isSelf && account.isAdmin ? ownAccountHint : null}

      <h3>{disabled ? 'Enable' : 'Disable'}</h3>
      <p className="muted">
        {disabled
          ? 'The account is disabled: nobody can sign in to it. Mail for it still arrives.'
          : 'A disabled account cannot be signed in to, by password, passkey or app password. Mail for it still arrives.'}
      </p>
      <div className="actions">
        {disabled ? (
          <button
            type="button"
            className="button"
            disabled={status.isPending}
            onClick={() => {
              only(status);
              status.mutate('active');
            }}
          >
            Enable account
          </button>
        ) : (
          <ConfirmButton
            label="Disable account"
            title="Disable this account?"
            confirmLabel="Disable account"
            danger
            disabled={isSelf || status.isPending}
            onConfirm={() => {
              only(status);
              status.mutate('disabled');
            }}
          >
            <p>
              <strong>{id}</strong> will be signed out and unable to sign in
              until the account is enabled again.
            </p>
          </ConfirmButton>
        )}
      </div>
      {isSelf && !disabled ? ownAccountHint : null}

      <Notice
        error={changes.find((change) => change.error)?.error}
        success={
          setPasswordChange.isSuccess
            ? 'The password was set.'
            : signOut.isSuccess
              ? 'All sessions were ended.'
              : admin.isSuccess
                ? 'The role was changed.'
                : status.isSuccess
                  ? 'The account was updated.'
                  : null
        }
      />
    </Section>
  );
}

function AccountAppPasswords({
  id,
  readOnly,
}: {
  id: string;
  readOnly: boolean;
}) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['account-app-passwords', id],
    queryFn: () => api.accountAppPasswords(id),
  });
  const revoke = useMutation({
    mutationFn: (appPasswordId: string) =>
      api.revokeAccountAppPassword(id, appPasswordId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['account-app-passwords', id],
      }),
  });
  return (
    <Section
      title="App passwords"
      description="The passwords this user’s mail apps sign in with. You can revoke one, for a lost device; only the user can create one."
    >
      {list.isPending ? (
        <Loading what="the app passwords" />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <p className="muted">This account has no app passwords.</p>
      ) : (
        <ul className="rows">
          {list.data.map((password) => (
            <li key={password.id} className="row">
              <div>
                <div className="row-title">{password.label}</div>
                <div className="muted small">
                  Created {formatDate(password.createdAt)} · Last used{' '}
                  {formatDate(password.lastUsedAt, 'never')}
                </div>
              </div>
              {readOnly ? null : (
                <ConfirmButton
                  label="Revoke"
                  title="Revoke this app password?"
                  confirmLabel="Revoke app password"
                  danger
                  disabled={revoke.isPending}
                  onConfirm={() => revoke.mutate(password.id)}
                >
                  <p>
                    The app using <strong>{password.label}</strong> will stop
                    being able to read or send {id}’s mail.
                  </p>
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <Notice
        error={revoke.error}
        success={revoke.isSuccess ? 'The app password was revoked.' : null}
      />
    </Section>
  );
}

/** For a removal that got stuck: closing a closed account asks for it again. */
function RemoveMailAgain({ account }: { account: AccountDetail }) {
  const { api } = useServices();
  const again = useAccountChange(account.id, () =>
    api.closeAccount(account.id),
  );
  return (
    <Section title="Removing mail">
      <p>
        This normally finishes within minutes of closing, longer for a large
        mailbox. If the account is still listed long after, ask for the removal
        again.
      </p>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={again.isPending}
          onClick={() => again.mutate()}
        >
          Remove mail again
        </button>
      </div>
      <Notice
        error={again.error}
        success={again.isSuccess ? 'The removal was asked for again.' : null}
      />
    </Section>
  );
}

function CloseAccount({
  account,
  isSelf,
}: {
  account: AccountDetail;
  isSelf: boolean;
}) {
  const { api } = useServices();
  const close = useAccountChange(account.id, () =>
    api.closeAccount(account.id),
  );
  return (
    <Section title="Close account">
      <p>Closing an account cannot be undone. When you close it:</p>
      <ul>
        <li>
          the user can no longer sign in, and their app passwords stop working;
        </li>
        <li>its addresses stop delivering, so mail sent to them is dropped;</li>
        <li>it is no longer shared with anyone;</li>
        <li>its mail is removed, which takes a few minutes or more;</li>
        <li>
          the id <strong>{account.id}</strong> is kept until then, so that it
          cannot be given to someone else while the mail still exists.
        </li>
      </ul>
      <div className="actions">
        <ConfirmButton
          label="Close account"
          title={`Close ${account.id}?`}
          confirmLabel="Close account permanently"
          danger
          disabled={isSelf || close.isPending}
          typeToConfirm={account.id}
          onConfirm={() => close.mutate()}
        >
          <p>
            This cannot be undone. The user will be signed out and the account’s
            addresses will stop delivering.
          </p>
        </ConfirmButton>
      </div>
      {isSelf ? (
        <p className="hint">
          This is your own account. Another administrator has to do this.
        </p>
      ) : null}
      <Notice error={close.error} />
    </Section>
  );
}
