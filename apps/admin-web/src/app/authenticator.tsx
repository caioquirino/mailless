import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import qrcode from 'qrcode-generator';
import {
  ConfirmButton,
  LoadError,
  Loading,
  Notice,
  Section,
} from './components';
import { useServices } from './services';

/** What an authenticator app reads to learn a secret, and whose it is. */
function setupAddress(username: string, secret: string): string {
  const issuer = 'Mailless';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${username}`)}?${new URLSearchParams(
    { secret, issuer },
  ).toString()}`;
}

/** The secret as a picture to scan. Drawn here: it goes to no other site. */
function ScanCode({ value }: { value: string }) {
  const squares = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(value);
    code.make();
    const size = code.getModuleCount();
    let path = '';
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        if (code.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`;
      }
    }
    return { size, path };
  }, [value]);
  const edge = squares.size + 8;
  return (
    <svg
      className="scan-code"
      role="img"
      aria-label="Code to scan with the authenticator app"
      viewBox={`-4 -4 ${edge} ${edge}`}
      shapeRendering="crispEdges"
    >
      <rect x={-4} y={-4} width={edge} height={edge} fill="#fff" />
      <path d={squares.path} fill="#000" />
    </svg>
  );
}

/**
 * A second step at sign-in: a code from an authenticator app, asked for
 * after the password. Set up here, since the sign-in pages only ask for it.
 */
export function Authenticator({ username }: { username: string }) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const state = useQuery({
    queryKey: ['my-authenticator'],
    queryFn: api.myAuthenticator,
  });
  const changed = () =>
    queryClient.invalidateQueries({ queryKey: ['my-authenticator'] });
  const begin = useMutation({
    mutationFn: api.beginMyAuthenticator,
    onSuccess: (begun) => {
      setSecret(begun.secret);
      setCode('');
    },
  });
  const confirm = useMutation({
    mutationFn: api.confirmMyAuthenticator,
    onSuccess: () => {
      setSecret(null);
      setCode('');
      return changed();
    },
  });
  const remove = useMutation({
    mutationFn: api.removeMyAuthenticator,
    onSuccess: changed,
  });
  const digits = code.replace(/\D/g, '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (digits.length === 6) confirm.mutate(digits);
  };

  return (
    <Section
      title="Authenticator app"
      description="A second step when you sign in: after your password, a six-digit code from an app on your phone. Someone who learns your password still cannot get in."
    >
      {state.isPending ? (
        <Loading what="your sign-in settings" />
      ) : state.isError ? (
        <LoadError error={state.error} onRetry={() => void state.refetch()} />
      ) : state.data.enabled ? (
        <>
          <p>
            <strong>On.</strong> A code from your authenticator app is asked for
            every time you sign in. Signing in is then by password and code:
            passkeys are not offered. Mail apps go on using their app passwords.
          </p>
          <div className="actions">
            <ConfirmButton
              label="Turn off"
              title="Stop asking for a code?"
              confirmLabel="Stop asking for a code"
              danger
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            >
              <p>
                Your password alone will be enough to sign in. You can remove
                the entry from your authenticator app afterwards.
              </p>
            </ConfirmButton>
          </div>
        </>
      ) : secret === null ? (
        <>
          <p className="muted">
            <strong>Off.</strong> No code is asked for when you sign in. While
            it is on, you sign in with your password and a code, and not with a
            passkey.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={begin.isPending}
              onClick={() => begin.mutate()}
            >
              Set up an authenticator
            </button>
          </div>
        </>
      ) : (
        <form className="authenticator-setup" onSubmit={submit}>
          <ol>
            <li>
              In your authenticator app, add an account and scan this code. On
              this device,{' '}
              <a href={setupAddress(username, secret)}>open the app</a> instead.
              <ScanCode value={setupAddress(username, secret)} />
              <span className="muted small">
                Or type this key into the app:
              </span>
              <code className="secret-value authenticator-key">
                {secret.match(/.{1,4}/g)?.join(' ')}
              </code>
            </li>
            <li>
              <label htmlFor="authenticator-code">Code from the app</label>
              <input
                id="authenticator-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </li>
          </ol>
          <div className="actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={confirm.isPending || digits.length !== 6}
            >
              Turn on
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setSecret(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <Notice error={begin.error ?? confirm.error ?? remove.error} />
    </Section>
  );
}
