# admin-web

The mailless admin interface: a React application served by the admin
function under `/admin/`.

- **My account**, for every signed-in user: change the password, add and
  remove passkeys, make and revoke app passwords for mail apps.
- **Accounts**, for administrators: make, rename, disable and close accounts;
  set passwords and end sessions; addresses, shares and the administrator
  role.

It is a client of the [admin API](../../libs/admin/api) and of nothing else,
through the [generated client](../../libs/admin/client): when the API changes
in a way a screen depends on, this app stops compiling.

## Signing in

Signing in happens on the identity provider's own pages (OpenID Connect
authorization code flow with PKCE). Nothing about the provider is built in:
the pages read where to send people from `/admin/config.json`, which the
function fills from its configuration.

The tokens are kept for as long as the tab is open: in memory, and in the
tab's session storage so that a reload does not sign out. That storage
belongs to the one tab and is emptied when it closes. Scripts of the page can
read it, which is why the page is served with a Content-Security-Policy that
lets no script or style in from anywhere else (so there are no inline styles
and nothing from other sites in it). When what was kept has run out and
cannot be renewed, the page goes to the provider once, whose own session
sends it straight back signed in, to the address it was at.

## Working on it

```sh
pnpm nx test admin-web
pnpm nx build admin-web
```

To run it on your own machine against a real deployment, allow sign-in to
come back to it (`admin_extra_callback_urls = ["http://localhost:5173/admin/callback"]`
in `infra/terraform.tfvars`, then apply) and start it with the deployment as
its backend:

```sh
ADMIN_BACKEND=https://mail.example.com pnpm nx dev admin-web
```

The browser then sees one origin, so the API needs no CORS.

## How it reaches people

`pnpm nx build mailless-service` builds this app, packs the result into the
admin function's bundle (`tools/embed-web.mjs`) and so deploys it with
the function: there is no bucket or CDN to keep in step.
