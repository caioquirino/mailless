# @mailless/jmap-server

A [JMAP](https://jmap.io) server framework for TypeScript (RFC 8620 core,
RFC 8621 mail). It knows nothing about HTTP frameworks or databases: you give
it a storage adapter and call `handleRequest` from whatever hosts it, such as a
Lambda function, a Node HTTP server or a worker.

## Usage

```ts
import { createJmapServer } from '@mailless/jmap-server';
import { InMemoryStorageAdapter } from '@mailless/jmap-server/memory';

const jmap = createJmapServer({
  storage: new InMemoryStorageAdapter(),
  urls: {
    api: 'https://mail.example.com/jmap/api',
    download:
      'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}?type={type}',
    upload: 'https://mail.example.com/jmap/upload/{accountId}',
    eventSource:
      'https://mail.example.com/jmap/events?types={types}&closeafter={closeafter}&ping={ping}',
  },
});

// Authentication is the host's job. Pass the result in on every call.
const auth = { accountId: 'u1', username: 'me@example.com' };

await jmap.provisionAccount(auth); // Inbox, Drafts, Sent, Archive, Junk, Trash
const session = jmap.getSession(auth); // serve at /.well-known/jmap
const response = await jmap.handleRequest(JSON.parse(body), auth);
```

`handleRequest` throws `RequestError` when the request as a whole is rejected;
answer with `error.toProblemDetails()` as `application/problem+json` and
`error.status`. Failures of individual method calls are returned inside the
response, as JMAP requires.

Other entry points on the server object:

| Method                                                                        | Purpose                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `upload(auth, accountId, bytes, type)`                                        | Store a blob; returns the JMAP upload response.                                          |
| `download(auth, accountId, blobId)`                                           | Bytes of an uploaded blob, a stored message, or one decoded body part; `null` if absent. |
| `importMessage(auth, raw, { mailboxIds, keywords?, receivedAt?, delivery? })` | Store a raw RFC 5322 message as an Email. For inbound mail, pass `delivery: true`.       |
| `pushStateChange(accountId, types?)`                                          | Tell the account's push subscriptions that data changed. See [Push](#push).              |
| `registerMethod(name, { capability, handler })`                               | Add or replace a method.                                                                 |

### HTTP

`@mailless/jmap-server/http` turns a server into a function from a Fetch API
`Request` to a `Response`, with the standard routes, size limits, error
responses and safe download headers:

```ts
import { createFetchHandler, jmapUrls } from '@mailless/jmap-server/http';

const jmap = createJmapServer({
  storage,
  urls: jmapUrls('https://mail.example.com'),
});
const handle = createFetchHandler({
  server: jmap,
  authenticate: async (request) => lookUp(request.headers.get('authorization')),
});
```

It serves `GET /.well-known/jmap`, `POST /jmap/api`,
`POST /jmap/upload/{accountId}` and
`GET /jmap/download/{accountId}/{blobId}/{name}`. Because it only uses
`Request` and `Response`, the same handler runs behind `node:http`
([`apps/dev-server`](../../apps/dev-server/src/main.ts)), API Gateway and
Lambda ([`apps/mailless-service`](../../apps/mailless-service/src/api.ts)), or
an edge runtime.

### App passwords

`@mailless/jmap-server/auth` keeps per-client passwords in the metadata store,
for hosts that authenticate with HTTP Basic:

```ts
import {
  createAppPasswordStore,
  isAppPassword,
} from '@mailless/jmap-server/auth';

const passwords = createAppPasswordStore(storage.metadata);
const { secret } = await passwords.create('account-1', 'Phone'); // shown once
(await passwords.verify('account-1', secret)) !== null; // true until revoked
```

Secrets are 150 bits of randomness and only their SHA-256 hash is stored.
`verify` compares against every stored hash in constant time, and records the
time of use at most once an hour.

## Supported methods

| Method                                                                       | Notes                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Core/echo`                                                                  |                                                                                                                                                                                                                                            |
| `Mailbox/get`, `/changes`, `/query`, `/set`                                  | Including `updatedProperties`, `sortAsTree`, `filterAsTree`, `onDestroyRemoveEmails`.                                                                                                                                                      |
| `Email/get`                                                                  | Metadata, headers in every `header:Name:asForm` variant, the MIME tree as it is in the message with each part's headers, body values in the part's charset, and the body and attachment lists RFC 8621 §4.1.4 derives.                     |
| `Email/query`                                                                | Every RFC 8621 filter condition, including full-text `text` and `body`; sorting; `collapseThreads`; paging and anchors.                                                                                                                    |
| `Email/set`                                                                  | Create drafts and messages to send, from `textBody` / `htmlBody` / `attachments` or any `bodyStructure`, with headers in every form on the message and on its parts; update `keywords` and `mailboxIds`; destroy.                          |
| `Email/import`                                                               |                                                                                                                                                                                                                                            |
| `Email/parse`                                                                | Reads a blob as a message without storing it, such as a message attached to another.                                                                                                                                                       |
| `SearchSnippet/get`                                                          | Subject and body excerpts with matches wrapped in `<mark>`.                                                                                                                                                                                |
| `Email/changes`, `Thread/get`, `Thread/changes`                              |                                                                                                                                                                                                                                            |
| `Identity/get`, `/changes`, `/set`                                           | Which identities exist, and their addresses, come from the `identities` option. `Identity/set` changes the name, reply-to, bcc and signatures; it refuses to create or destroy.                                                            |
| `EmailSubmission/set`, `/get`, `/changes`, `/query`, `/queryChanges`         | Sends immediately through the `transport` option, with `onSuccessUpdateEmail` and `onSuccessDestroyEmail`.                                                                                                                                 |
| `PushSubscription/get`, `/set`                                               | With the `push` option; see [Push](#push). Without it, there are no subscriptions and none can be made.                                                                                                                                    |
| `Mailbox/queryChanges`, `Email/queryChanges`, `EmailSubmission/queryChanges` | Calculated from the change log, so a client can bring a cached result list up to date instead of fetching it again. Everything that changed is reported as removed and, if still a result, added back at its place, which the spec allows. |
| `VacationResponse/get`, `/set`                                               | Offered when the server can send; see [Vacation response](#vacation-response).                                                                                                                                                             |
| `Email/copy`, `Blob/copy`                                                    | Between two accounts the user may use; see [Shared accounts](#shared-accounts). With `onSuccessDestroyOriginal`, a copy is a move.                                                                                                         |

Also implemented: result references, creation-id references across calls,
`ifInState`, `maxChanges` paging, request and object limits, and mailbox
counts (`totalEmails`, `unreadEmails`, `totalThreads`, `unreadThreads`) that
are kept correct under concurrent writes.

### Sending

The submission capability is offered only when the server is given a
`transport` (see `@mailless/transport-ses`) and, usually, `identities`:

```ts
const jmap = createJmapServer({
  storage,
  urls,
  transport, // { send(message, envelope) }
  identities: (auth) => [
    { id: 'main', email: 'me@example.com', name: 'Me' },
    { id: 'any', email: '*@example.com' }, // any address at the domain
  ],
});
```

A client may set any header when creating a message, including `From` in raw
form. What it may send is decided at submission: a message can only be
submitted if every address in its `From` header, and the envelope sender, is
covered by the chosen identity. The `Bcc` header is
removed from what is sent and kept on the stored copy. Header values supplied
by clients are rejected if they contain line breaks, so one header cannot be
used to smuggle in another.

Each message is handed to the transport with `tags` naming its account and
submission. When the transport later learns what happened, the host calls
`jmap.recordDelivery(auth, submissionId, { 'bob@example.org': { delivered:
'no', smtpReply: '550 no such user' } })`, which updates the submission's
`deliveryStatus`. A known outcome is never undone by a late or repeated report,
except that a failure overrides an earlier success.

### Push

With the `push` option, clients can register push subscriptions (RFC 8620
§7.2): a URL at a push service, to which the server POSTs a small `StateChange`
object whenever the account's data changes. This is how a mail app on a phone
learns of new mail without keeping a connection open.

```ts
const jmap = createJmapServer({
  storage,
  urls,
  push: {}, // defaults: 16 subscriptions per account, 30-day lifetime
  // In a single long-running process, push as soon as something is written:
  onStateChange: (accountId, types) =>
    void jmap.pushStateChange(accountId, types),
});
```

The server does not decide by itself when to push; the host calls
`pushStateChange(accountId, types?)`. A single process can do that from
`onStateChange`, as above. A host made of short-lived functions should not,
because the function may stop before the request to the push service is made:
there, drive it from the database's change feed instead, as
[`apps/mailless-service`](../../apps/mailless-service) does with a DynamoDB
stream. The call returns counts (`sent`, `failed`, `removed`) and never throws
because a push service is unreachable.

What it does and guards against:

- **Verification.** A new subscription is sent a `PushVerification` object and
  receives nothing else until the client echoes the code, so the server cannot
  be pointed at a URL whose owner did not ask for it.
- **Where it will connect.** Only `https` URLs whose host is a domain name
  outside the suffixes reserved for private use; never an IP address. Redirects
  are not followed. Replace the rule with `push.allowUrl`. The host name is not
  resolved, so if the server runs where private addresses are reachable, also
  restrict its outgoing connections.
- **Encryption.** A subscription with `keys` gets every push encrypted to them
  (RFC 8291, `aes128gcm`), so the push service cannot read it.
- **Privacy.** `url` and `keys` are never returned by `PushSubscription/get`.
  A push carries state strings only: which kinds of data changed, nothing
  about the mail.
- **Lifetime.** Subscriptions expire (clients renew by updating `expires`),
  and are removed when their push service answers 404 or 410. After a 429 the
  subscription is left alone for as long as `Retry-After` says.
- **`EmailDelivery`.** This state moves only for mail imported with
  `importMessage(..., { delivery: true })`, so a client can subscribe to new
  mail without being woken by its own edits.

Not done: subscriptions belong to the account rather than to the credentials
that created them, so revoking one device's password does not remove its
subscription (it expires on its own); and there is no VAPID, which browser
push services require.

### Full-text search

`text` looks in From, To, Cc, Bcc, Subject, attachment file names and the
body; `body` looks in the body only, which includes text attachments. The body
is the plain text part, or the HTML part with its markup removed.

- Words outside quotes must all be present, in any order, and each also
  matches longer words it begins: `invoic` finds "invoice".
- Text in single or double quotes is a phrase, matched word for word.
- Case, accents and punctuation are ignored. Chinese, Japanese, Thai and other
  scripts written without spaces are matched character by character.

There is no search service behind this. Each email has a companion record
holding its words, written and destroyed in the same commit as the email, and
a search reads those records. That costs nothing while idle and is always
consistent; like other queries here, it reads every candidate, which suits
personal mailboxes. Emails stored before search existed are caught up on by
the first search that covers them. Only about the first 60,000 characters of a
message's text are searchable.

### Shared accounts

A user has one account of their own. The host may give them others, such as a
mailbox a team shares, by listing them in what `authenticate` returns:

```ts
const auth = {
  accountId: 'ann',
  username: 'ann@example.com',
  sharedAccounts: {
    team: { name: 'Team mailbox' },
    records: { isReadOnly: true },
  },
};
```

The accounts appear in the session, and any method call that names one in
`accountId` runs there: its mailboxes, its mail, its identities. An account
not listed does not exist as far as that user can tell. In a read-only account
every method that changes something answers `accountReadOnly`, as does an
upload. Push subscriptions are told about changes to the user's own account
only.

### Vacation response

With a `transport`, the server offers the vacation response capability: one
settings object per account (`isEnabled`, dates, subject, text and HTML
bodies). When a message is imported with `delivery: true` and the response is
due, the reply is sent through the transport, to the envelope sender recorded
in `Return-Path`.

Automatic replies are easy to get wrong, so the rules of RFC 3834 are applied
before anything is sent. No reply goes to a bounce, to mail marked as
automatic, to mailing lists or bulk mail, to addresses such as `no-reply` or
`mailer-daemon`, to junk, to mail that does not name one of the user's
addresses in To or Cc, or to the user themself. Each sender is answered once a
week at most, and once more when the response is changed. Replies carry
`Auto-Submitted: auto-replied`. A reply that cannot be sent never stops the
mail from being delivered; `onAutoReply` is told what happened.

### Not implemented yet

- Delayed sending and cancelling: messages are handed over at once, so
  `undoStatus` is always `final`.
- Push over EventSource or WebSocket; push subscriptions are supported.

### Known simplifications

- **Emails stored by earlier versions** kept a simplified body layout. Their
  real structure is read from the raw message whenever `bodyStructure`,
  `textBody`, `htmlBody`, `attachments` or `bodyValues` is asked for, which
  costs one read of the message.
- **Queries are evaluated in memory** over the candidate records the adapter
  returns (one mailbox when the filter requires `inMailbox`, otherwise the
  whole account). That is fine for personal mailboxes and will not scale to
  very large ones without a search backend.
- **Uniqueness rules for mailboxes** (sibling names, roles) are checked before
  writing but not enforced atomically, so two simultaneous requests could both
  pass.

## Writing a storage adapter

An adapter is a `{ metadata, blobs }` pair implementing `MetadataStore` and
`BlobStore` from this package. The contract is intentionally small:

- `get`, `list` (optionally by one index key) over versioned records
- `commit`: one atomic batch of `create`, `update` (with a version check),
  `increment` (atomic counters, no version check) and `destroy`, with an
  optional expected-state check
- `getState` and `getChanges` over a per-account change log
- `put`, `get`, `delete` for blobs

Filters, sorting, threading and counting are done by the server, so an adapter
never needs to understand JMAP.

To check an adapter, run the exported suites from a spec file in its package
(they use [Vitest](https://vitest.dev)):

```ts
import {
  describeJmapConformance,
  describeStorageContract,
} from '@mailless/jmap-server/testing';
import { MyAdapter } from './my-adapter.js';

describeStorageContract('my adapter', () => new MyAdapter());
describeJmapConformance('my adapter', () => new MyAdapter());
```

`describeStorageContract` tests the contract directly;
`describeJmapConformance` drives the whole server through the adapter with
JMAP requests. The factory must return an empty adapter on each call.

## Development

```sh
pnpm nx test jmap-server
pnpm nx build jmap-server
```

Requires Node.js 22.12 or newer. Licensed under Apache-2.0.
