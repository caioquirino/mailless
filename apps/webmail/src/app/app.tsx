import { useLocation } from 'react-router';
import { lazy, Suspense } from 'react';
import { MailShell } from './shell';
import { useServices, useSignedIn } from './services';
import { CallbackPage, SignInPage } from './sign-in';

const EventWindow = lazy(() =>
  import('./calendar').then((module) => ({ default: module.EventWindow })),
);

/** Everything, once the services exist: which screen to show to whom. */
export function App() {
  const { session } = useServices();
  const signedIn = useSignedIn(session);
  const location = useLocation();

  // The provider sends the browser back here whether or not anyone is signed in yet.
  if (location.pathname === '/callback') return <CallbackPage />;
  if (!signedIn) return <SignInPage />;
  // An event being written in a window of its own has the window to itself.
  if (location.pathname === '/calendar/event') {
    return (
      <Suspense fallback={null}>
        <EventWindow />
      </Suspense>
    );
  }
  return <MailShell />;
}
