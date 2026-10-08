# @mailless/jmap-server

A [JMAP](https://jmap.io) server for TypeScript with everything this project
offers: mail (RFC 8621), contacts (RFC 9610) and sharing (RFC 9670) on one
engine (RFC 8620). It knows nothing about HTTP frameworks or databases: you
give it a storage adapter and call `handleRequest` from whatever hosts it, such
as a Lambda function, a Node HTTP server or a worker.

It is put together from parts, and a server that wants less, or something of
its own, is put together from the same ones:

| Package                                  | What it is                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`@mailless/jmap-engine`](../engine)     | Requests, sessions, accounts, blobs, push, the standard methods and the storage contract. Knows no kind of data. |
| [`@mailless/jmap-mail`](../mail)         | Mailboxes, emails, threads, sending, vacation response, read receipts, blob management and quota.                |
| [`@mailless/jmap-contacts`](../contacts) | Address books and cards.                                                                                         |
| [`@mailless/jmap-sharing`](../sharing)   | Principals and share notifications.                                                                              |

`createJmapServer(options)` is `createJmapEngine` with those three modules,
and takes the options of the engine and of mail together. This README
describes the whole.

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
([`apps/dev-server`](../../../apps/dev-server/src/main.ts)), API Gateway and
Lambda ([`apps/mailless-service`](../../../apps/mailless-service/src/api.ts)), or
an edge runtime.

### App passwords

Hosts that authenticate with HTTP Basic can give each mail app a password of
its own with [`@mailless/app-passwords`](../../identity/app-passwords), which
keeps them in this server's metadata store:
`createAppPasswordStore(storage.metadata)`.

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
| `Blob/upload`, `/get`, `/lookup`                                             | RFC 9404: make a blob from text, base64 and pieces of other blobs; read a blob or a range of it with digests; find the emails, threads and mailboxes that refer to one.                                                                    |
| `Quota/get`, `/changes`, `/query`, `/queryChanges`                           | RFC 9425, with the `quota` option; see [Quota](#quota).                                                                                                                                                                                    |
| `MDN/parse`, `/send`                                                         | RFC 9007 read receipts, offered when the server can send; see [Read receipts](#read-receipts).                                                                                                                                             |
| `Principal/*`, `ShareNotification/*`                                         | RFC 9670; see [Principals](#principals).                                                                                                                                                                                                   |
| `AddressBook/*`, `ContactCard/*`                                             | RFC 9610 contacts, with cards as JSContact (RFC 9553); see [Contacts](#contacts).                                                                                                                                                          |
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
[`apps/mailless-service`](../../../apps/mailless-service) does with a DynamoDB
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

### Sending later, and undoing a send

With a `scheduler`, a client may ask for a message to be held: a few seconds,
so that "undo send" has something to undo, or until a date. It does so with
the `HOLDFOR` or `HOLDUNTIL` parameter of the envelope sender, as in SMTP's
FUTURERELEASE extension, up to `maxDelayedSend` seconds (default 30 days).

```ts
const jmap = createJmapServer({
  storage,
  urls,
  transport,
  // In one long-running process a timer will do:
  scheduler: {
    schedule: async ({ accountId, submissionId, sendAt }) => {
      setTimeout(
        () =>
          void jmap.sendScheduled(
            { accountId, username: accountId },
            submissionId,
          ),
        sendAt.getTime() - Date.now(),
      );
    },
  },
});
```

A held submission is `pending`. Setting its `undoStatus` to `canceled` stops
it, until the moment sending starts; after that the answer is `cannotUnsend`.
A cancellation and a send can never both succeed, and several wake-ups for the
same message send it once.

What is sent is the message as it was when submitted. It is kept apart from
the email, which may be edited, moved or destroyed meanwhile without changing
what goes out. Who may send it was checked at submission. A held submission
cannot be destroyed, only cancelled.

If the transport refuses the message when its time comes, each recipient's
`deliveryStatus` says so. If sending fails for another reason, `sendScheduled`
throws and should be called again; a crash at the wrong instant can, rarely,
send a message twice, never lose it.

### Quota

With `quota: { maxOctets }`, each account has one quota (`maxOctets` is a
number for all accounts, or a function asked per account that answers null
for an account without a limit): the octets its mail
takes up, against that limit. The count is kept in a record of its own that
moves in the same commit as the mail, so it is always right, and an account
from before the count existed is counted the first time it is needed.

What the user adds beyond the limit (`Email/import`, `Email/set` create) is
refused with `overQuota`. Mail imported with `delivery: true` is never refused:
the sender could do nothing about a full mailbox. Without the option there is
no quota to show, and nothing is limited.

### Read receipts

`MDN/parse` reads a message disposition notification, from this server or any
other, and says which email it answers when there is exactly one with that
Message-ID. `MDN/send` answers a message that asked for a receipt:

- only a message with a `Disposition-Notification-To` header gets one, and it
  goes to the address in that header and nowhere else;
- the same request must set the `$mdnsent` keyword on the message, and a
  message that has it is not answered again;
- `includeOriginalMessage` attaches the original's headers, not its content.

### Principals

A principal stands for whoever owns an account. A user sees the principal of
their own account and one for each account shared with them, in their own
account; nothing else on the server is listed. The directory comes from what
the host says about the user, so `Principal/set` refuses every change, and
`Principal/changes` can only say "start over" when it has changed.

`ShareNotification` objects can be read, queried and dismissed. The server
does not create any yet: sharing is set by the host, not through the API, so
there is no moment at which a change of rights is seen.

### Contacts

An account has address books, and cards in them. `provisionAccount` gives an
account one address book, its default, when it has none. A card is stored as
the client gave it, so properties from JSContact extensions survive; what RFC
9553 defines is checked for its type and its mandatory members, and a card
that fails is refused with the paths of what is wrong. The server adds what a
card must have and the client left out: `uid`, `created`, `updated`.

- `ContactCard/query` supports every filter and sort of RFC 9610. Text is
  matched without regard to case; words may be anywhere, and a quoted phrase
  must appear as it is. `ContactCard/queryChanges` is calculated.
- A photo can be an uploaded blob (`blobId` in place of `uri`). It must be an
  image, which is told from the content, not from what the upload claimed.
  `ContactCard/copy` copies such files along with the card.
- A card is one record, so it may take up 256 KiB at most. Larger files
  belong in a blob. A `data:` URI is kept as it is and not turned into a blob.
- `shareWith` is always null: access is given to a whole account (see
  [Shared accounts](#shared-accounts)), not to one address book.

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

- Push over EventSource or WebSocket; push subscriptions are supported.

### Choices the specification leaves open

Where RFC 8620 and 8621 allow more than one behaviour, this server does what
the other JMAP servers do, which is also what Fastmail's test suite expects:

- **Sorting text** is octet by octet unless a comparator names a collation, so
  capital letters come first. `i;ascii-casemap` ignores case.
- **Threads** follow the reply chain. `threadsRequireSameSubject` adds the
  check RFC 8621 §3 recommends, that a reply also keeps the subject.
- **`isSubscribed`** is false on a new mailbox unless the client sets it.
  `subscribeNewMailboxes` makes it true, for mail apps that show only
  subscribed mailboxes.
- **An account the user cannot use** is `accountNotFound` on either side of a
  `/copy`, where the RFC also defines `fromAccountNotFound` for the source.
- **State strings** always begin with a letter, so that none can be mistaken
  for an empty value.

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
- `purge` on both: removes everything of one account, in steps that can be
  stopped and taken up again, for when an account is closed

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
