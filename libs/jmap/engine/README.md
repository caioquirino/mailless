# @mailless/jmap-engine

The JMAP engine (RFC 8620): requests and result references, sessions,
accounts a user may use, blobs, push subscriptions and the standard methods.
It knows no kind of data. Mail, contacts and the rest come as modules, each
bringing its methods and what the session says about it.

For a server with everything, use
[`@mailless/jmap-server`](../server), which is this engine with the project's
modules. Use the engine itself to offer less, or something of your own.

```ts
import { createJmapEngine } from '@mailless/jmap-engine';
import { InMemoryStorageAdapter } from '@mailless/jmap-engine/memory';
import { contactsModule } from '@mailless/jmap-contacts';

// A server with contacts and nothing else.
const engine = createJmapEngine({
  storage: new InMemoryStorageAdapter(),
  urls,
  modules: [contactsModule()],
});

await engine.provisionAccount(auth);
const session = engine.getSession(auth);
const response = await engine.handleRequest(request, auth);
```

## What the engine does

- **Requests**: checks the envelope and `using`, runs the calls in order,
  resolves result references and creation ids, and turns failures into the
  error types of the specification.
- **Accounts**: a user has an account of their own and may be given others
  (`auth.sharedAccounts`), to change or only to read. A call runs in the
  account it names, or is answered `accountNotFound`. A read-only account
  gets storage that refuses writes.
- **Blobs**: upload, download and `Blob/copy`.
- **Push**: `PushSubscription/get` and `/set` with Web Push encryption, and
  `pushStateChange` for the host to call when something changed.
- **HTTP**: `createFetchHandler` from `@mailless/jmap-engine/http` serves the
  session, the API, uploads and downloads from `Request` to `Response`.

## Writing a module

A module is an object: `JmapModule`.

| Member                                        | For                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `capabilities`, `accountCapabilities(access)` | What the session says the server and each account can do.                        |
| `methods`                                     | The methods by name, each with the capability a request must name to call it.    |
| `extendContext(ctx)`                          | Adds what the module's methods need to every context, under a name of its own.   |
| `provisionAccount(ctx)`                       | What a new account starts with.                                                  |
| `prepareAccount(ctx)`                         | What must be true of an account before it is used; seen to once per account.     |
| `pushedTypes`                                 | The data types whose changes are pushed to clients.                              |
| `readBlob(ctx, blobId)`                       | Blobs that are a part of something else, such as an attachment inside a message. |

Methods are written with the same pieces the project's own modules use, all
exported from here: `standardSet`, `standardChanges`, `loadForGet`,
`filterAndSort`, `paginate`, `queryChanges`, `commit`, `parseArguments` and
the rest. A module that needs settings on the context declares them:

```ts
declare module '@mailless/jmap-engine' {
  interface MethodContext {
    notes: { maxLength: number };
  }
}
```

and fills them in `extendContext`.

## Storage

The engine keeps everything through two small interfaces, `MetadataStore`
(versioned records, index lookups, an atomic batch write and a change log)
and `BlobStore`. `@mailless/jmap-engine/memory` has both in memory.
`describeStorageContract` from `@mailless/jmap-engine/testing` is the test
suite an adapter must pass; see
[Writing a storage adapter](../server/README.md#writing-a-storage-adapter).
