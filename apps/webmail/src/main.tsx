import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { browserTheme } from '@mailless/ui';
import { Session } from '@mailless/web-session';
import { App } from './app/app';
import { ServicesProvider, type Services } from './app/services';
import { createMailClient } from './lib/client';
import { appBaseUrl, loadConfig } from './lib/config';

// Before anything is drawn, so that the page opens in the theme that was chosen.
const theme = browserTheme();

async function start(): Promise<Services> {
  const config = await loadConfig();
  const session = new Session(config, {
    fetch: (input, init) => fetch(input, init),
    storage: window.sessionStorage,
    navigate: (url) => window.location.assign(url),
    now: () => Date.now(),
    baseUrl: appBaseUrl(),
    storageKey: 'mailless.mail',
  });
  // After a reload: pick up where this tab left off, before anything is shown.
  await session.restore();
  const client = createMailClient({
    sessionUrl: new URL(config.sessionUrl, window.location.origin).href,
    session,
    // While being worked on, the page is in front of a server that names another site as its own.
    ...(import.meta.env.DEV ? { sameOrigin: window.location.origin } : {}),
  });
  const base = appBaseUrl();
  return {
    config,
    session,
    client,
    theme,
    push: {
      storage: window.localStorage,
      serviceWorker:
        'serviceWorker' in navigator && 'PushManager' in window
          ? navigator.serviceWorker
          : undefined,
      workerUrl: new URL('sw.js', base).href,
      scope: new URL(base).pathname,
      permission: () =>
        'Notification' in window ? Notification.permission : undefined,
      requestPermission: () => Notification.requestPermission(),
      now: () => Date.now(),
    },
  };
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
          <h1>mailless</h1>
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
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <App />
      </BrowserRouter>
    </ServicesProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
