import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { SignInError } from '@mailless/web-session';
import { useServices } from './services';

export function SignInPage({ message }: { message?: string }) {
  const { session } = useServices();
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  // This tab was signed in and what it kept has run out: sign in again without being asked. Decided once, on arrival.
  const [resuming] = useState(() => !message && session.takeResume());
  const [starting, setStarting] = useState(false);
  const begun = useRef(false);
  useEffect(() => {
    if (!resuming || begun.current) return;
    begun.current = true;
    void session.beginSignIn(here);
  }, [resuming, session, here]);

  if (resuming) {
    return (
      <main className="centered">
        <p role="status" className="muted">
          Signing you in again…
        </p>
      </main>
    );
  }
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
            void session.beginSignIn(here);
          }}
        >
          {starting ? 'Opening the sign-in page…' : 'Sign in'}
        </button>
        <p className="muted small">
          You stay signed in until you sign out or close this tab.
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
        if (current) void navigate(session.takeReturnPath(), { replace: true });
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
