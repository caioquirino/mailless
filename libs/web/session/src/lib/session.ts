import { challengeFor, randomToken, sameText } from './pkce.js';

/*
 * Who is signed in. Signing in happens on the identity provider's own pages
 * (OpenID Connect authorization code flow with PKCE). What comes back is kept
 * for as long as the tab is open: in memory, and in the tab's session storage
 * so that a reload does not sign out. That storage belongs to this tab alone
 * and is emptied when it closes; scripts of this page can read it, which is
 * why the page is served so that no other script can run in it.
 *
 * An application may ask for longer, by naming somewhere else to keep the
 * tokens (`kept`): one installed on someone's own device, which closing would
 * otherwise sign out every time. They then stay until signing out, which
 * also takes back the refresh token at the provider.
 *
 * When what was kept has run out and cannot be renewed, the page goes to the
 * provider, whose own session sends it straight back signed in.
 */

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops being accepted, in milliseconds since the epoch. */
  expiresAt: number;
}

/** Sign-in did not work. The message is fit to show; it never holds a code or a token. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

/** The identity provider's addresses and the client this page signs in as. None of it is secret. */
export interface SessionConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  logoutUrl: string;
  scopes: string[];
  /** Where a refresh token is taken back on signing out, when the provider has such a place. */
  revokeUrl?: string | null;
  /** The provider's page for adding a passkey, when it has one. */
  passkeyEnrolmentUrl?: string | null;
}

export interface SessionDependencies {
  fetch: typeof fetch;
  /** Holds the verifier and state for the trip to the provider and back, and nothing else. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /**
   * Where the tokens are kept, when that is not `storage`: storage that
   * outlasts the tab, for an application installed on a device of one's own.
   */
  kept?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Sends the browser to another address. */
  navigate(url: string): void;
  now(): number;
  /** Where the application is served, ending in "/": `https://host/admin/`. */
  baseUrl: string;
  /**
   * What the keys in `storage` start with, such as `mailless.admin`. Two
   * applications on one site share its storage, and must not share a name.
   */
  storageKey: string;
}

/** A token this close to running out is renewed rather than used. */
const NEARLY_OVER_MS = 5_000;

function storedTokens(text: string | null): Tokens | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<Tokens> | null;
    return value &&
      typeof value.accessToken === 'string' &&
      value.accessToken !== '' &&
      typeof value.expiresAt === 'number' &&
      (value.refreshToken === null || typeof value.refreshToken === 'string')
      ? {
          accessToken: value.accessToken,
          refreshToken: value.refreshToken ?? null,
          expiresAt: value.expiresAt,
        }
      : null;
  } catch {
    return null;
  }
}

/** An address inside the interface to go back to, or null for anything else. */
function innerPath(value: unknown): string | null {
  return typeof value === 'string' &&
    /^\/(?!\/)/.test(value) &&
    !value.startsWith('/callback')
    ? value
    : null;
}
/** Renew this long before the token runs out. */
const RENEW_AHEAD_MS = 60_000;

export class Session {
  private tokens: Tokens | null = null;
  private readonly listeners = new Set<() => void>();
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private renewing: Promise<boolean> | undefined;
  /** The exchange under way, by code, so that asking twice exchanges once. */
  private exchange: { code: string; done: Promise<boolean> } | undefined;
  private returnPath: string | null = null;

  /** Tokens kept from before a reload that have run out, to renew in `restore`. */
  private lapsed: Tokens | null = null;

  /** Holds the verifier and state for the trip to the provider and back. */
  private readonly PENDING_KEY: string;
  /** The tokens, for as long as the tab is open. */
  private readonly TOKENS_KEY: string;
  /** Says only that this tab was signed in, so that it may sign in again by itself when the tokens have run out. */
  private readonly RESUME_KEY: string;
  private readonly kept: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

  constructor(
    private readonly config: SessionConfig,
    private readonly deps: SessionDependencies,
  ) {
    this.PENDING_KEY = `${deps.storageKey}.sign-in`;
    this.TOKENS_KEY = `${deps.storageKey}.tokens`;
    this.RESUME_KEY = `${deps.storageKey}.was-signed-in`;
    this.kept = deps.kept ?? deps.storage;
    const kept = storedTokens(this.kept.getItem(this.TOKENS_KEY));
    if (!kept) return;
    if (kept.expiresAt - deps.now() > NEARLY_OVER_MS) this.adopt(kept);
    else this.lapsed = kept;
  }

  /**
   * Finishes picking up where the tab left off before a reload: tokens that
   * have run out since are renewed if they can be. To be awaited once, before
   * anything is shown.
   */
  async restore(): Promise<void> {
    const lapsed = this.lapsed;
    this.lapsed = null;
    if (!lapsed || this.isSignedIn) return;
    const tokens = await this.renewed(lapsed);
    // Someone signed in while this was being asked: leave that as it is.
    if (this.isSignedIn) return;
    if (tokens) this.adopt(tokens);
    else this.kept.removeItem(this.TOKENS_KEY);
  }

  /**
   * Fresh tokens for ones that are running out, or null when there are none
   * to be had. A provider that gives a new refresh token each time takes the
   * old one back, so when it refuses, another window of this application may
   * have renewed already: what that one kept is used, or renewed in turn.
   */
  private async renewed(current: Tokens): Promise<Tokens | null> {
    if (current.refreshToken) {
      const tokens = await this.requestTokens({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        refresh_token: current.refreshToken,
      });
      // The provider may keep the refresh token it gave before.
      if (tokens) {
        return {
          ...tokens,
          refreshToken: tokens.refreshToken ?? current.refreshToken,
        };
      }
    }
    const other = storedTokens(this.kept.getItem(this.TOKENS_KEY));
    if (!other || other.refreshToken === current.refreshToken) return null;
    return other.expiresAt - this.deps.now() > NEARLY_OVER_MS
      ? other
      : this.renewed(other);
  }

  get redirectUri(): string {
    return `${this.deps.baseUrl}callback`;
  }

  get isSignedIn(): boolean {
    return this.tokens !== null;
  }

  /** The token to send with a call, or undefined when nobody is signed in. */
  accessToken(): string | undefined {
    return this.tokens?.accessToken;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Whether to sign in again without being asked: this tab was signed in, and
   * what it kept has run out and could not be renewed. True once; if signing
   * in again does not work, the user is asked, rather than sent round in
   * circles.
   */
  takeResume(): boolean {
    if (this.isSignedIn) return false;
    const resume = this.deps.storage.getItem(this.RESUME_KEY) !== null;
    this.deps.storage.removeItem(this.RESUME_KEY);
    return resume;
  }

  /** Where the user was when sign-in began, to go back to once; `/` when nowhere in particular. */
  takeReturnPath(): string {
    const path = this.returnPath ?? '/';
    this.returnPath = null;
    return path;
  }

  /**
   * Goes to the provider's sign-in page. `returnTo` is the address inside the
   * interface to come back to afterwards.
   */
  async beginSignIn(returnTo?: string): Promise<void> {
    const state = randomToken();
    const verifier = randomToken();
    this.deps.storage.setItem(
      this.PENDING_KEY,
      JSON.stringify({ state, verifier, returnTo: innerPath(returnTo) }),
    );
    const url = new URL(this.config.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: this.config.scopes.join(' '),
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
    }).toString();
    this.deps.navigate(url.href);
  }

  /**
   * Finishes what `beginSignIn` started, from the parameters the provider
   * sent the browser back with. True when someone is now signed in; false
   * when there was nothing to finish (the provider sends people back here
   * from other pages too, such as the one for adding a passkey).
   */
  completeSignIn(params: URLSearchParams): Promise<boolean> {
    const code = params.get('code');
    if (code !== null && this.exchange?.code === code)
      return this.exchange.done;
    const done = this.finish(params);
    if (code !== null) this.exchange = { code, done };
    return done;
  }

  private async finish(params: URLSearchParams): Promise<boolean> {
    const refusal = params.get('error');
    if (refusal !== null) {
      this.deps.storage.removeItem(this.PENDING_KEY);
      throw new SignInError(
        refusal === 'access_denied'
          ? 'Sign-in was cancelled.'
          : 'The sign-in page reported a problem.',
      );
    }
    const code = params.get('code');
    if (code === null) return this.isSignedIn;

    const stored = this.deps.storage.getItem(this.PENDING_KEY);
    // Used once, whatever comes of it.
    this.deps.storage.removeItem(this.PENDING_KEY);
    let pending: { state?: unknown; verifier?: unknown; returnTo?: unknown } =
      {};
    try {
      pending = stored ? (JSON.parse(stored) as typeof pending) : {};
    } catch {
      // Treated as if nothing had been started.
    }
    const state = params.get('state') ?? '';
    if (
      typeof pending.state !== 'string' ||
      typeof pending.verifier !== 'string' ||
      !sameText(pending.state, state)
    ) {
      throw new SignInError(
        'This sign-in was not started from this page. Please sign in again.',
      );
    }

    const tokens = await this.requestTokens({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });
    if (!tokens) {
      throw new SignInError(
        'Sign-in could not be completed. Please try again.',
      );
    }
    this.returnPath = innerPath(pending.returnTo);
    this.adopt(tokens);
    return true;
  }

  /** Asks the token endpoint; null when it refuses or cannot be reached. */
  private async requestTokens(
    form: Record<string, string>,
  ): Promise<Tokens | null> {
    let body: Record<string, unknown>;
    try {
      const response = await this.deps.fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
      if (!response.ok) return null;
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const accessToken = body['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') return null;
    const lifetime = Number(body['expires_in']);
    const refreshToken = body['refresh_token'];
    return {
      accessToken,
      refreshToken:
        typeof refreshToken === 'string' && refreshToken !== ''
          ? refreshToken
          : null,
      expiresAt:
        this.deps.now() +
        (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 300) * 1000,
    };
  }

  private adopt(tokens: Tokens): void {
    this.tokens = tokens;
    this.kept.setItem(this.TOKENS_KEY, JSON.stringify(tokens));
    this.deps.storage.setItem(this.RESUME_KEY, '1');
    clearTimeout(this.renewTimer);
    if (tokens.refreshToken !== null) {
      const wait = Math.max(
        tokens.expiresAt - this.deps.now() - RENEW_AHEAD_MS,
        5_000,
      );
      this.renewTimer = setTimeout(() => void this.renew(), wait);
    }
    this.changed();
  }

  /**
   * Gets a fresh access token with the refresh token. False when that is not
   * possible, in which case the user has to sign in again.
   */
  renew(): Promise<boolean> {
    this.renewing ??= (async () => {
      const current = this.tokens;
      if (!current?.refreshToken) return false;
      const tokens = await this.renewed(current);
      // Signed out, or signed in afresh, while waiting: leave that as it is.
      if (this.tokens !== current) return this.isSignedIn;
      if (!tokens) return false;
      this.adopt(tokens);
      return true;
    })().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  /** Forgets who is signed in, here only. */
  forget(): void {
    clearTimeout(this.renewTimer);
    this.exchange = undefined;
    this.lapsed = null;
    this.kept.removeItem(this.TOKENS_KEY);
    if (this.tokens === null) return;
    this.tokens = null;
    this.changed();
  }

  /** Signs out here and at the provider. */
  signOut(): void {
    const refreshToken = this.tokens?.refreshToken ?? this.lapsed?.refreshToken;
    if (refreshToken && this.config.revokeUrl) {
      // Taken back at the provider, so that a copy of it is worth nothing.
      // Not waited for: signing out here does not depend on it.
      void this.deps
        .fetch(this.config.revokeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: refreshToken,
            client_id: this.config.clientId,
          }).toString(),
          keepalive: true,
        })
        .catch(() => undefined);
    }
    this.forget();
    // Signed out on purpose: a reload must not sign in again by itself.
    this.deps.storage.removeItem(this.RESUME_KEY);
    const url = new URL(this.config.logoutUrl);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      logout_uri: this.deps.baseUrl,
    }).toString();
    this.deps.navigate(url.href);
  }

  /** Goes to the provider's page for adding a passkey, which sends the user back here. */
  addPasskey(): void {
    if (!this.config.passkeyEnrolmentUrl) return;
    const url = new URL(this.config.passkeyEnrolmentUrl);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
    }).toString();
    this.deps.navigate(url.href);
  }
}
