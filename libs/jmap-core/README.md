# @mailless/jmap-core

Protocol building blocks for [JMAP](https://jmap.io) (RFC 8620 core and
RFC 8621 mail) in TypeScript. It has no I/O and no platform dependencies, so
it runs in Node.js, browsers and edge runtimes. Its only runtime dependency is
[Zod](https://zod.dev).

It is the shared base of `@mailless/jmap-server` and the planned
`@mailless/jmap-client`.

## What is in it

- **Types** for requests, responses, invocations, the Session object,
  capabilities, the standard method responses, and the mail data model
  (`Mailbox`, `Email`, `EmailBodyPart`, `Thread`, `Identity`,
  `EmailSubmission`, filter conditions).
- **Zod schemas** for the request envelope, ids, dates, and the arguments of
  the standard `/get`, `/changes`, `/set`, `/query` and `/queryChanges`
  methods. Unknown arguments are rejected.
- **Result references** (RFC 8620 §3.7): `resolveResultReferences` and the
  underlying `evaluatePointer`, including the `*` wildcard.
- **Patch objects** (RFC 8620 §5.3): `applyPatch` and `patchedProperties`.
- **Errors**: `RequestError` (whole request rejected, maps to
  `application/problem+json`), `MethodError` (one call failed) and
  `SetFailure` (one object in a `/set` call rejected).

## Example

```ts
import {
  applyPatch,
  RequestSchema,
  resolveResultReferences,
} from '@mailless/jmap-core';

const request = RequestSchema.parse(JSON.parse(body));

const args = resolveResultReferences(
  { '#ids': { resultOf: 'c1', name: 'Email/query', path: '/ids' } },
  [['Email/query', { ids: ['e1', 'e2'] }, 'c1']],
);
// { ids: ['e1', 'e2'] }

applyPatch(
  { keywords: { $seen: true } },
  { 'keywords/$flagged': true, 'keywords/$seen': null },
);
// { keywords: { $flagged: true } }
```

## Development

```sh
pnpm nx test jmap-core
pnpm nx build jmap-core
```

Requires Node.js 22.12 or newer. Licensed under Apache-2.0.
