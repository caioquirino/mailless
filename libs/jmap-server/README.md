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

| Method                                                             | Purpose                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `upload(auth, accountId, bytes, type)`                             | Store a blob; returns the JMAP upload response.                                          |
| `download(auth, accountId, blobId)`                                | Bytes of an uploaded blob, a stored message, or one decoded body part; `null` if absent. |
| `importMessage(auth, raw, { mailboxIds, keywords?, receivedAt? })` | Store a raw RFC 5322 message as an Email. Use this for inbound delivery.                 |
| `registerMethod(name, { capability, handler })`                    | Add or replace a method.                                                                 |

The reference host is [`apps/dev-server`](../../apps/dev-server/src/main.ts),
about two hundred lines of `node:http`.

## Supported methods

| Method                                          | Notes                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Core/echo`                                     |                                                                                                          |
| `Mailbox/get`, `/changes`, `/query`, `/set`     | Including `updatedProperties`, `sortAsTree`, `filterAsTree`, `onDestroyRemoveEmails`.                    |
| `Email/get`                                     | Metadata, headers in every `header:Name:asForm` variant, body structure, body values.                    |
| `Email/query`                                   | All RFC 8621 filter conditions except `text` and `body`; sorting; `collapseThreads`; paging and anchors. |
| `Email/set`                                     | Update `keywords` and `mailboxIds`; destroy.                                                             |
| `Email/import`                                  |                                                                                                          |
| `Email/changes`, `Thread/get`, `Thread/changes` |                                                                                                          |
| `Mailbox/queryChanges`, `Email/queryChanges`    | Always answer `cannotCalculateChanges`, which the spec allows.                                           |

Also implemented: result references, creation-id references across calls,
`ifInState`, `maxChanges` paging, request and object limits, and mailbox
counts (`totalEmails`, `unreadEmails`, `totalThreads`, `unreadThreads`) that
are kept correct under concurrent writes.

### Not implemented yet

- Creating emails with `Email/set` (drafts), `Email/copy`, `Email/parse`,
  `SearchSnippet/get`.
- `Identity`, `EmailSubmission` (sending) and `VacationResponse`.
- Push (EventSource or WebSocket).
- Full-text search: `text` and `body` filters answer `unsupportedFilter`.

### Known simplifications

- **MIME structure is normalised.** A message is exposed as a text body, an
  HTML body and attachments under a synthesised `multipart/alternative` /
  `multipart/mixed` tree. The original part tree and per-part headers are not
  preserved. The raw message is always available through its `blobId`.
- **`sentAt` is converted to UTC**; the sender's original offset is dropped.
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
