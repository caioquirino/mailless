# @mailless/jmap-client

A typed [JMAP](https://jmap.io) client (RFC 8620 and RFC 8621) for
TypeScript. It talks to any JMAP server, and needs nothing but `fetch`, so it
runs in Node.js, in a browser and on the edge.

```ts
import { createJmapClient } from '@mailless/jmap-client';

const client = createJmapClient({
  sessionUrl: 'https://mail.example.com/.well-known/jmap',
  authorization: `Bearer ${token}`,
});

// The ten newest messages of the inbox, in one request.
const inbox = await client.call('Mailbox/query', { filter: { role: 'inbox' } });

const batch = client.batch();
const query = batch.call('Email/query', {
  filter: { inMailbox: inbox.ids[0] },
  sort: [{ property: 'receivedAt', isAscending: false }],
  limit: 10,
});
const emails = batch.call('Email/get', {
  '#ids': query.ref('/ids'),
  properties: ['subject', 'from', 'receivedAt', 'preview'],
});
const result = await batch.send();

for (const email of result.get(emails).list) {
  console.log(email.receivedAt, email.subject);
}
```

## What it does

- **The session.** Where to send calls, upload and download is read from the
  session, once. It is read again when the server says it changed.
- **Batches.** Calls collected with `batch.call` go out as one request, and
  the server runs them in order. A later call can use what an earlier one
  found: `query.ref('/ids')` is a result reference (RFC 8620 §3.7).
- **Types.** For the methods of mail (`Mailbox`, `Thread`, `Email`,
  `Identity`, `EmailSubmission`), arguments and responses are typed. Any
  other method can be called too, with plain objects.
- **Less to spell out.** A call that names no account is for the user's own.
  What a request must say it `using` is worked out from the methods called.
- **Blobs.** `client.upload(data, { type })` and `client.download(blobId)`.
- **Sign-in.** `authorization` is the header to send. Give a function and it
  is asked before every request, which is where an expiring token is renewed.

## Keeping a copy in step

A mail app does not ask for everything each time: it keeps what it has
looked at, and asks the server what changed since (RFC 8620 §5.2 and §5.6).

```ts
import { ObjectCache, QueryView, sync } from '@mailless/jmap-client';

// Every mailbox; and of messages, the ones asked for.
const mailboxes = new ObjectCache<Mailbox>(client, {
  type: 'Mailbox',
  everything: true,
});
const emails = new ObjectCache<Email>(client, {
  type: 'Email',
  properties: ['threadId', 'mailboxIds', 'keywords', 'from', 'subject'],
  changing: ['mailboxIds', 'keywords'], // all that changes once a message exists
});
// The inbox, newest first, a page at a time.
const inbox = new QueryView(client, {
  type: 'Email',
  filter: { inMailbox: inboxId },
  sort: [{ property: 'receivedAt', isAscending: false }],
});

await Promise.all([mailboxes.load(), inbox.load()]);
await emails.load(inbox.ids);

// Later: one request brings all three up to date.
await sync(client, [mailboxes, emails, inbox]);
```

- `sync` asks each part what changed and applies it. When the server no
  longer knows (`cannotCalculateChanges`), that part is asked for again
  whole, without the caller having to care.
- `subscribe(listener)` and `version` say when something held changed, which
  is what a view draws from (React's `useSyncExternalStore` takes them as
  they are).
- `loadIn(batch, ids)` asks as part of a batch, where the ids may be what an
  earlier call finds: a list, its messages and their conversations in one
  request.
- `patch`, `remove` and `drop` change what is held before the server has
  been told, so that what is shown follows at once; the next `sync` puts
  whatever the server says in its place.

## Errors

- `JmapRequestError`: the server refused the whole request (a wrong sign-in,
  a request too large). It has the HTTP `status` and the problem `type`.
- `JmapMethodError`: one call of a batch failed; the others stand. It is
  thrown by `result.get(call)` for that call only, and has the error `type`
  (`invalidArguments`, `accountNotFound`, ...). `result.ok(call)` tells
  without throwing.

What a `/set` call could not create, update or destroy is not an error: it is
in the response, under `notCreated`, `notUpdated` and `notDestroyed`.

## More methods

A method this package has no types for needs to be told which capability it
belongs to, unless its data type is one of the well-known ones (contacts,
quota, blobs, principals, the vacation response):

```ts
await client.call(
  'Calendar/get',
  { ids: null },
  {
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'],
  },
);
```

To have types for it, add to `MethodMap`:

```ts
declare module '@mailless/jmap-client' {
  interface MethodMap {
    'Calendar/get': { args: GetArguments; response: GetResponse<Calendar> };
  }
}
```

## Not there yet

Push (EventSource, WebSocket and push subscriptions): for now, `sync` is
called when there is reason to think something changed, or on a timer.

## Tests

`pnpm nx test jmap-client` runs it against a real server from
[`@mailless/jmap-server`](../server), in the same process and without a
network.
