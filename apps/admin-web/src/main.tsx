import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { App } from './app/app';
import { ServicesProvider, type Services } from './app/services';
import { ApiFailure, createApi } from './lib/api';
import { appBaseUrl, loadConfig } from './lib/config';
import { Session } from './lib/session';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refusal is an answer; asking again does not change it.
      retry: (failures, error) =>
        failures < 2 && !(error instanceof ApiFailure && error.status > 0),
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

async function start(): Promise<Services> {
  const config = await loadConfig();
  const session = new Session(config, {
    fetch: (input, init) => fetch(input, init),
    storage: window.sessionStorage,
    navigate: (url) => window.location.assign(url),
    now: () => Date.now(),
    baseUrl: appBaseUrl(),
  });
  // Whoever signs in next must not see what the last user's screens held.
  session.subscribe(() => {
    if (!session.isSignedIn) queryClient.clear();
  });
  const api = createApi(
    session,
    new URL(config.apiBaseUrl, window.location.origin).href.replace(/\/$/, ''),
  );
  return { config, session, api };
}

function Root() {
  const [services, setServices] = useState<Services | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    start().then(
      (started) => current && setServices(started),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, []);

  if (failed) {
    return (
      <main className="centered">
        <div className="card card-narrow">
          <h1>mailless admin</h1>
          <p className="notice notice-error" role="alert">
            This page could not start. Reload it; if that does not help, the
            server is not set up for it yet.
          </p>
        </div>
      </main>
    );
  }
  if (!services) {
    return (
      <main className="centered">
        <p role="status" className="muted">
          Loading…
        </p>
      </main>
    );
  }
  return (
    <ServicesProvider value={services}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ServicesProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
