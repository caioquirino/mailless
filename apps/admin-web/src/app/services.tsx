import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Api } from '../lib/api';
import type { AppConfig } from '../lib/config';
import type { Theme } from '@mailless/ui';
import type { Session } from '@mailless/web-session';

/** What every screen works with: where things are, who is signed in, and the API. */
export interface Services {
  config: AppConfig;
  session: Session;
  /** Light or dark. Left out where there is no page to restyle. */
  theme?: Theme;
  api: Api;
}

const ServicesContext = createContext<Services | null>(null);

export const ServicesProvider = ServicesContext.Provider;

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('No services were provided');
  return services;
}

/** Whether someone is signed in, kept in step with the session. */
export function useSignedIn(session: Session): boolean {
  return useSyncExternalStore(session.subscribe, () => session.isSignedIn);
}
