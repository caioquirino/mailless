import { useQuery } from '@tanstack/react-query';
import { NavLink, Route, Routes, useLocation } from 'react-router';
import type { Me } from '@mailless/admin-client';
import { ThemeSwitch } from '@mailless/ui';
import { AccountDetailPage } from './account-detail';
import { AccountsPage } from './accounts';
import { LoadError, Loading } from './components';
import { MyAccountPage } from './my-account';
import { useServices, useSignedIn } from './services';
import { CallbackPage, SignInPage } from './sign-in';

/** Everything, once the services exist: which screen to show to whom. */
export function App() {
  const { session } = useServices();
  const signedIn = useSignedIn(session);
  const location = useLocation();

  // The provider sends the browser back here whether or not anyone is signed in yet.
  if (location.pathname === '/callback') return <CallbackPage />;
  if (!signedIn) return <SignInPage />;
  return <SignedIn />;
}

function SignedIn() {
  const { api, session, theme } = useServices();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">mailless admin</span>
        <nav aria-label="Main">
          <NavLink to="/" end>
            My account
          </NavLink>
          {me.data?.isAdmin ? <NavLink to="/accounts">Accounts</NavLink> : null}
        </nav>
        <div className="topbar-user">
          {me.data ? <span className="muted">{me.data.username}</span> : null}
          {theme ? <ThemeSwitch theme={theme} /> : null}
          <button
            type="button"
            className="button button-small"
            onClick={() => session.signOut()}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        {me.isPending ? (
          <Loading what="your account" />
        ) : me.isError ? (
          <LoadError error={me.error} onRetry={() => void me.refetch()} />
        ) : (
          <Routes>
            <Route path="/" element={<MyAccountPage me={me.data} />} />
            <Route
              path="/accounts"
              element={
                <AdminOnly me={me.data}>
                  <AccountsPage />
                </AdminOnly>
              }
            />
            <Route
              path="/accounts/:id"
              element={
                <AdminOnly me={me.data}>
                  <AccountDetailPage me={me.data} />
                </AdminOnly>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function AdminOnly({ me, children }: { me: Me; children: React.ReactNode }) {
  if (me.isAdmin) return children;
  return (
    <>
      <h1>For administrators</h1>
      <p className="muted">
        You are signed in as {me.username}, who is not an administrator, so you
        cannot manage accounts. An administrator can give you that role.
      </p>
      <p>
        <NavLink to="/">Go to my account</NavLink>
      </p>
    </>
  );
}

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p className="muted">There is nothing at this address.</p>
      <p>
        <NavLink to="/">Go to my account</NavLink>
      </p>
    </>
  );
}
