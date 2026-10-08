# @mailless/web-session

Sign-in for a web application that runs in a browser, with any OpenID Connect
provider: the authorization code flow with PKCE (RFC 7636), on the provider's
own pages. It needs no secret, which a browser could not keep.

```ts
import { Session } from '@mailless/web-session';

const session = new Session(
  {
    clientId: 'my-client',
    authorizeUrl: 'https://auth.example.com/oauth2/authorize',
    tokenUrl: 'https://auth.example.com/oauth2/token',
    logoutUrl: 'https://auth.example.com/logout',
    scopes: ['openid'],
  },
  {
    fetch: (input, init) => fetch(input, init),
    storage: window.sessionStorage,
    navigate: (url) => window.location.assign(url),
    now: () => Date.now(),
    baseUrl: 'https://app.example.com/',
    storageKey: 'my-app',
  },
);

await session.restore(); // after a reload, before anything is shown
if (!session.isSignedIn) await session.beginSignIn();

// On the page the provider sends the browser back to (`<baseUrl>callback`):
await session.completeSignIn(new URLSearchParams(location.search));
session.accessToken(); // to send with calls; renewed before it runs out
```

Tokens are kept for as long as the tab is open: in memory, and in the storage
it is given so that a reload does not sign out. Serve the page so that no
script but its own can run in it.
