# @mailless/app-passwords

Passwords for mail apps. Each app gets one of its own, so the user's real
password never has to be typed into an app, and one app can be shut out
without touching the others.

```ts
import { createAppPasswordStore, isAppPassword } from '@mailless/app-passwords';

const passwords = createAppPasswordStore(storage.metadata);
const { secret } = await passwords.create('account-1', 'Phone'); // shown once
(await passwords.verify('account-1', secret)) !== null; // true until revoked
await passwords.list('account-1'); // labels and dates, never secrets
```

- A secret is 150 bits of randomness, written as `mlapp-` and six groups of
  five letters and digits. Spaces and capitals make no difference, so it can
  be typed as it is read.
- Only its SHA-256 hash is stored: a secret that long cannot be guessed, so a
  slow hash would add nothing.
- `verify` compares against every stored hash in constant time, and records
  when a password was last used at most once an hour, so a busy app does not
  cause a write per request.
- `isAppPassword(password)` tells by its shape whether a password is one of
  these, so that a host can route it here without a lookup and never offer
  it to an identity provider.

## Where they are kept

`createAppPasswordStore` takes anything with `get`, `list` and `commit` for
records by account and type (`AppPasswordRecords`). That is the part of a
[`@mailless/jmap-server`](../../jmap/server) metadata store they need, so such
a store can be passed as it is, and the passwords then live next to the mail
they open. This package depends on neither: anything that keeps records will
do.
