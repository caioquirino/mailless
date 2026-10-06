# mailless

A mailbox without a mail server to run: serverless email on AWS, reached over
[JMAP](https://jmap.io) instead of IMAP, built from reusable TypeScript
libraries.

> **Status: early.** The protocol core and the server framework work and are
> tested against in-memory storage. AWS storage, the Terraform stack, the
> client library and sending mail are not built yet. Nothing has been
> published to npm.

## Why JMAP

IMAP and POP3 are long-lived, stateful TCP protocols, which do not fit
request-based compute such as Lambda. JMAP (RFC 8620 and RFC 8621) is JSON over
HTTPS with batched calls and explicit state tokens for sync, so a mailbox can
be served by functions that only run while a request is in flight.

## Packages

| Package                                     | What it is                                                                                                                            | State   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [`@mailless/jmap-core`](libs/jmap-core)     | Protocol types, validators, result references, patch objects. No I/O; runs anywhere.                                                  | Working |
| [`@mailless/jmap-server`](libs/jmap-server) | JMAP server framework: request engine, Mailbox / Email / Thread methods, storage contract, in-memory adapter, conformance test suite. | Working |
| `@mailless/storage-dynamodb`, `-s3`, `-fs`  | Storage adapters for AWS and for self-hosting.                                                                                        | Planned |
| `@mailless/jmap-client`                     | Typed JMAP client.                                                                                                                    | Planned |

`apps/dev-server` is a small local JMAP server over in-memory storage for
trying things out.

## Try it

Requires Node.js 22.12 or newer (24 recommended, see `.nvmrc`) and pnpm.

```sh
pnpm install
pnpm nx serve dev-server
```

In another terminal:

```sh
AUTH='Authorization: Bearer dev-token'

# The session object: capabilities, account, endpoint URLs
curl -s -H "$AUTH" http://127.0.0.1:8080/.well-known/jmap

# Newest five emails with their subjects, in one round trip
curl -s -H "$AUTH" -H 'Content-Type: application/json' http://127.0.0.1:8080/jmap/api -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [
    ["Email/query", {"accountId": "dev", "limit": 5,
      "sort": [{"property": "receivedAt", "isAscending": false}]}, "q"],
    ["Email/get", {"accountId": "dev",
      "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"},
      "properties": ["subject", "from", "preview"]}, "g"]
  ]
}'
```

To add mail, `POST` a raw message to `/jmap/upload/dev` and pass the returned
`blobId` to `Email/import`. The dev server keeps everything in memory, has one
fixed account, and listens on localhost only.

## Development

```sh
pnpm nx run-many -t lint typecheck test build   # everything
pnpm nx test jmap-server                        # one project
pnpm nx graph                                   # project graph
```

This is an [Nx](https://nx.dev) workspace. Build, test and lint tooling
(TypeScript, Vitest, ESLint, esbuild) is installed at the versions Nx pins and
upgraded only with `pnpm nx migrate latest`, so the toolchain moves as one.

Lint enforces the dependency direction between projects: `jmap-core` depends on
nothing, `jmap-server` and `jmap-client` depend only on `jmap-core`, storage
adapters depend on those two, and libraries never import apps.

## Design in one paragraph

All JMAP behaviour (filters, sorting, threading, mailbox counts, change
tracking) lives in `@mailless/jmap-server`. Storage backends implement a small
contract: versioned records, secondary-index lookups, one atomic batch write,
atomic counters, a change log, and a blob store. That keeps adapters short and
lets every adapter be checked by the same exported conformance suite. Metadata
goes to a database (DynamoDB on AWS) and message content to blob storage (S3);
the HTTP host (Lambda, or a plain Node server for self-hosting) is a thin
wrapper around `handleRequest`.

## Roadmap

1. ~~Workspace, `jmap-core`, `jmap-server` on in-memory storage~~
2. DynamoDB and S3 adapters; Terraform for SES inbound, S3, DynamoDB, DNS
3. `jmap-client`
4. Lambda service behind API Gateway, authentication, sending through SES
5. Push over WebSocket, `/queryChanges`, first npm release
6. Self-hosted build with docker-compose

## License

[Apache-2.0](LICENSE)
