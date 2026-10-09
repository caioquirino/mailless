import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me, NewAppPassword } from '@mailless/admin-client';
import {
  ConfirmButton,
  LoadError,
  Loading,
  Notice,
  Section,
  StatusBadge,
  Usage,
  formatDate,
} from './components';
import { useServices } from './services';
import { Authenticator } from './authenticator';

export function MyAccountPage({ me }: { me: Me }) {
  return (
    <>
      <h1>My account</h1>
      <Section title="Signed in as">
        <dl className="facts">
          <dt>Username</dt>
          <dd>{me.username}</dd>
          {me.account ? (
            <>
              <dt>Name</dt>
              <dd>
                {me.account.name ?? <span className="muted">Not set</span>}
              </dd>
              <dt>Mailbox</dt>
              <dd>
                <StatusBadge status={me.account.status} />
              </dd>
            </>
          ) : null}
          <dt>Role</dt>
          <dd>{me.isAdmin ? 'Administrator' : 'User'}</dd>
        </dl>
        {me.account ? (
          <>
            {me.usage ? (
              <>
                <h3>Mailbox</h3>
                <Usage usage={me.usage} />
              </>
            ) : null}
            <h3>Addresses</h3>
            {me.addresses.length === 0 ? (
              <p className="muted">No address delivers to your mailbox yet.</p>
            ) : (
              <ul className="plain-list">
                {me.addresses.map((address) => (
                  <li key={address}>
                    <code>{address}</code>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">You do not have a mailbox here.</p>
        )}
      </Section>
      {me.capabilities.changeOwnPassword ? <ChangePassword /> : null}
      {me.capabilities.manageOwnPasskeys ? <Passkeys /> : null}
      {me.capabilities.manageOwnAuthenticator ? (
        <Authenticator username={me.username} />
      ) : null}
      {me.account?.status === 'active' ? <AppPasswords /> : null}
    </>
  );
}

function ChangePassword() {
  const { api } = useServices();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      api.changeMyPassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setAgain('');
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    change.reset();
    if (next !== again) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    change.mutate();
  };
  return (
    <Section
      title="Password"
      description="The password you sign in with here. Mail apps use app passwords instead."
    >
      <form onSubmit={submit} className="form">
        <div className="field">
          <label htmlFor="current-password">Current password</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new-password-again">New password, again</label>
          <input
            id="new-password-again"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={mismatch}
            value={again}
            onChange={(event) => setAgain(event.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={change.isPending}
          >
            Change password
          </button>
        </div>
        {mismatch ? (
          <p className="notice notice-error" role="alert">
            The two new passwords are not the same.
          </p>
        ) : (
          <Notice
            error={change.error}
            success={change.isSuccess ? 'Your password was changed.' : null}
          />
        )}
      </form>
    </Section>
  );
}

function Passkeys() {
  const { api, config, session } = useServices();
  const queryClient = useQueryClient();
  const passkeys = useQuery({
    queryKey: ['my-passkeys'],
    queryFn: api.myPasskeys,
  });
  const remove = useMutation({
    mutationFn: api.removeMyPasskey,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['my-passkeys'] }),
  });
  return (
    <Section
      title="Passkeys"
      description="A passkey lets you sign in with your fingerprint, face or device PIN instead of a password."
    >
      {passkeys.isPending ? (
        <Loading what="your passkeys" />
      ) : passkeys.isError ? (
        <LoadError
          error={passkeys.error}
          onRetry={() => void passkeys.refetch()}
        />
      ) : passkeys.data.length === 0 ? (
        <p className="muted">You have no passkeys.</p>
      ) : (
        <ul className="rows">
          {passkeys.data.map((passkey) => (
            <li key={passkey.id} className="row">
              <div>
                <div className="row-title">{passkey.name ?? 'Passkey'}</div>
                <div className="muted small">
                  Added {formatDate(passkey.createdAt, 'at an unknown time')}
                </div>
              </div>
              <ConfirmButton
                label="Remove"
                title="Remove this passkey?"
                confirmLabel="Remove passkey"
                danger
                disabled={remove.isPending}
                onConfirm={() => remove.mutate(passkey.id)}
              >
                <p>
                  You will no longer be able to sign in with{' '}
                  <strong>{passkey.name ?? 'this passkey'}</strong>.
                </p>
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <Notice
        error={remove.error}
        success={remove.isSuccess ? 'The passkey was removed.' : null}
      />
      {config.passkeyEnrolmentUrl !== null ? (
        <div className="actions">
          <button
            type="button"
            className="button"
            onClick={() => session.addPasskey()}
          >
            Add a passkey
          </button>
          <span className="muted small">
            Opens the sign-in service, then brings you back here.
          </span>
        </div>
      ) : null}
    </Section>
  );
}

/** The one time a new app password can be read. */
function NewSecret({
  created,
  onDone,
}: {
  created: NewAppPassword;
  onDone(): void;
}) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="secret" role="group" aria-label="New app password">
      <p>
        <strong>App password for “{created.label}”.</strong> It is shown only
        this once.
      </p>
      <code className="secret-value">{created.secret}</code>
      <p className="small">
        In the mail app, sign in with your email address and this password in
        place of your own.
      </p>
      <div className="actions">
        <button type="button" className="button" onClick={() => void copy()}>
          Copy
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={onDone}
        >
          I have saved it
        </button>
        <span aria-live="polite" className="muted small">
          {copied === 'yes'
            ? 'Copied.'
            : copied === 'failed'
              ? 'Could not copy. Select the password and copy it yourself.'
              : ''}
        </span>
      </div>
    </div>
  );
}

function AppPasswords() {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const list = useQuery({
    queryKey: ['my-app-passwords'],
    queryFn: api.myAppPasswords,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['my-app-passwords'] });
  const create = useMutation({
    mutationFn: api.createMyAppPassword,
    // Nothing keeps the secret once the box showing it is gone.
    gcTime: 0,
    onSuccess: () => {
      setLabel('');
      return refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeMyAppPassword,
    onSuccess: refresh,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    revoke.reset();
    create.mutate(label.trim());
  };
  return (
    <Section
      title="App passwords"
      description="A separate password for each mail app or device. You can take one away without changing the others."
    >
      {create.data ? (
        <NewSecret created={create.data} onDone={() => create.reset()} />
      ) : null}
      {list.isPending ? (
        <Loading what="your app passwords" />
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <p className="muted">You have no app passwords.</p>
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
                  being able to read or send your mail.
                </p>
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="form form-inline">
        <div className="field">
          <label htmlFor="app-password-label">Where will you use it?</label>
          <input
            id="app-password-label"
            placeholder="Phone mail app"
            required
            maxLength={100}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className="button button-primary"
          disabled={create.isPending || label.trim() === ''}
        >
          Create app password
        </button>
      </form>
      <Notice
        error={create.error ?? revoke.error}
        success={revoke.isSuccess ? 'The app password was revoked.' : null}
      />
    </Section>
  );
}
