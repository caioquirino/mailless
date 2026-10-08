import { useLocation } from 'react-router';
import { MailShell } from './shell';
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
  return <MailShell />;
}
