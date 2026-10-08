# @mailless/admin-api

The mailless administration API. A signed-in user manages their own
credentials; an administrator manages accounts. It brings together the
[directory](../../directory/core) (who has a mailbox), the
[identity provider](../../identity/core) (who may sign in) and the app passwords mail
clients use, and knows nothing of where any of them is kept or of what serves
it: it is a [Hono](https://hono.dev) application, so it runs on Lambda, on a
plain Node server, or in a test.

```ts
import { createAdminApi } from '@mailless/admin-api';
import { Hono } from 'hono';

const api = createAdminApi({
  directory,
  identity,
  appPasswords,
  verifyToken, // from @mailless/identity
  adminRole: 'MAILLESS_ADMIN',
  audit: (entry) => console.log(JSON.stringify(entry)),
});

export default new Hono().route('/admin/api', api);
```

## What it offers

| Under       | For                | Does                                                                                                                                                                                                   |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/me`       | any signed-in user | Who they are; change their password; list and remove their passkeys; make, list and revoke their app passwords.                                                                                        |
| `/accounts` | administrators     | Make, rename, disable and close accounts; set a password; end a user's sessions; grant and revoke the administrator role; add and remove addresses and shares; list and revoke a user's app passwords. |

Every call needs an access token of the identity provider as a bearer token.
The token says who the caller is and whether they hold the administrator
role; nothing else does.

Rules worth knowing:

- An administrator cannot disable or delete themself, or take the role from
  themself. Another administrator can.
- Closing an account stops it being used at once: the user is removed, the
  addresses stop delivering, app passwords are revoked and shares end. The
  account stays listed as `deleting`, so that its id cannot be given to
  someone else while its mail still exists. Removing the mail itself is not
  part of this API yet.
- An administrator can see and revoke a user's app passwords but not make
  one: a secret is only ever shown to the user it belongs to.
- With the `usage` option, accounts are shown with how much their mailbox
  holds and how much it may hold. A mailbox that has not been counted yet is
  reported as unknown (`usedOctets: null`), which is not the same as empty.
- `audit` is told of every change (who, what, which account). It is never
  given a password, a secret or an address.

## The OpenAPI document

Each route is declared once, with its path, parameters, body and answers as
Zod schemas. Requests are validated against that declaration, and
[`openapi.json`](openapi.json) is written from it:

```sh
pnpm nx run admin-api:openapi
```

The file is committed, so a change to the API shows up in review. A test
fails when the file is not the one the code describes.
[`@mailless/admin-client`](../client) is generated from it.
