import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { SignInError } from '../lib/session';
import { useServices } from './services';

export function SignInPage({ message }: { message?: string }) {
  const { session } = useServices();
  const [starting, setStarting] = useState(false);
  return (
    <main className="centered">
      <div className="card card-narrow">
        <h1>mailless admin</h1>
        <p className="muted">
          Manage your password, passkeys and app passwords. Administrators also
          manage accounts here.
        </p>
        {message ? (
          <p className="notice notice-error" role="alert">
            {message}
          </p>
        ) : null}
        <button
          type="button"
          className="button button-primary button-wide"
          disabled={starting}
          onClick={() => {
            setStarting(true);
            void session.beginSignIn();
          }}
        >
          {starting ? 'Opening the sign-in page…' : 'Sign in'}
        </button>
        <p className="muted small">
          You stay signed in until you close or reload this page.
        </p>
      </div>
    </main>
  );
}

/**
 * Where the identity provider sends the browser back to: after signing in,
 * and after its other pages such as the one for adding a passkey.
 */
export function CallbackPage() {
  const { session } = useServices();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  // The parameters as they were on arrival; they are used once.
  const arrived = useRef(params);

  useEffect(() => {
    let current = true;
    session.completeSignIn(arrived.current).then(
      () => {
        if (current) void navigate('/', { replace: true });
      },
      (error: unknown) => {
        if (!current) return;
        setProblem(
          error instanceof SignInError
            ? error.message
            : 'Sign-in could not be completed. Please try again.',
        );
      },
    );
    return () => {
      current = false;
    };
  }, [session, navigate]);

  if (problem !== null) return <SignInPage message={problem} />;
  return (
    <main className="centered">
      <p role="status" className="muted">
        Signing you in…
      </p>
    </main>
  );
}
