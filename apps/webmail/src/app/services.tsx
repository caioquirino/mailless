import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { JmapClient } from '@mailless/jmap-client';
import type { Theme } from '@mailless/ui';
import type { Session } from '@mailless/web-session';
import type { AppConfig } from '../lib/config';
import type { Draft, Held, MailStore } from '../lib/mail';
import type {
  Notifications,
  NotificationsDependencies,
} from '../lib/notifications';

/** What every screen works with: where things are, who is signed in, and the mail server. */
export interface Services {
  config: AppConfig;
  session: Session;
  /** Light or dark. Left out where there is no page to restyle. */
  theme?: Theme;
  client: JmapClient;
  /** What the browser offers for notifications. Left out where there is no browser to notify. */
  push?: Omit<NotificationsDependencies, 'client'>;
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

/** What the screens of someone signed in work with. */
export interface SayOptions {
  action?: { label: string; act(): void };
  /** How long it stays, in seconds. A few, when nothing is said. */
  seconds?: number;
}

export interface Mail {
  store: MailStore;
  /** Opens a message to write. */
  compose(draft: Draft): void;
  /**
   * Does something that may fail, and tells the user if it does. Resolves to
   * whether it worked.
   */
  act(action: () => Promise<unknown>): Promise<boolean>;
  /**
   * Says something in passing: what was just done. With something to press
   * beside it when that can be taken back, for as long as it can.
   */
  say(message: string, options?: SayOptions): void;
  /** Takes back a message that is being held, and opens it to go on writing. */
  unsend(held: Pick<Held, 'submissionId' | 'emailId'>): Promise<void>;
  /** Telling the person of new mail when they are not looking. */
  notifications: Notifications;
}

const MailContext = createContext<Mail | null>(null);

export function MailProvider(props: { value: Mail; children: ReactNode }) {
  return (
    <MailContext.Provider value={props.value}>
      {props.children}
    </MailContext.Provider>
  );
}

export function useMail(): Mail {
  const mail = useContext(MailContext);
  if (!mail) throw new Error('Nobody is signed in');
  return mail;
}

/** Draws again whenever something held changes. Returns its version. */
export function useSynced(source: {
  subscribe(listener: () => void): () => void;
  readonly version: number;
}): number {
  return useSyncExternalStore(source.subscribe, () => source.version);
}

/**
 * What goes with saying that something was done: the way to take it back,
 * when there is one, and longer to reach for it.
 */
export function withUndo(
  mail: Pick<Mail, 'act' | 'say'>,
  back: (() => Promise<void>) | null,
): SayOptions {
  if (!back) return {};
  return {
    seconds: 8,
    action: {
      label: 'Undo',
      act: () =>
        void mail.act(back).then((undone) => {
          if (undone) mail.say('Undone');
        }),
    },
  };
}
