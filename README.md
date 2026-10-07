# mailless

A mailbox without a mail server to run: serverless email on AWS, reached over
[JMAP](https://jmap.io) instead of IMAP, built from reusable TypeScript
libraries.

> **Status: early, but usable.** Receiving, reading and sending work on real
> AWS and with a third-party JMAP client: mail for the domain is accepted by
> SES, stored in S3 and DynamoDB, served over a JMAP API with Cognito sign-in,
> and sent back out through SES with delivery and bounce reporting. Per-client
> app passwords are written and tested locally but not yet tried on AWS. There
> is no client library, and nothing has been published to npm.

## Why JMAP

IMAP and POP3 are long-lived, stateful TCP protocols, which do not fit
request-based compute such as Lambda. JMAP (RFC 8620 and RFC 8621) is JSON over
HTTPS with batched calls and explicit state tokens for sync, so a mailbox can
be served by functions that only run while a request is in flight.

## Packages

| Package                                               | What it is                                                                                                                            | State   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [`@mailless/jmap-core`](libs/jmap-core)               | Protocol types, validators, result references, patch objects. No I/O; runs anywhere.                                                  | Working |
| [`@mailless/jmap-server`](libs/jmap-server)           | JMAP server framework: request engine, Mailbox / Email / Thread methods, storage contract, in-memory adapter, conformance test suite. | Working |
| [`@mailless/storage-dynamodb`](libs/storage-dynamodb) | Metadata store on DynamoDB (or DynamoDB Local).                                                                                       | Working |
| [`@mailless/storage-s3`](libs/storage-s3)             | Blob store on S3 or an S3-compatible server.                                                                                          | Working |
| [`@mailless/storage-fs`](libs/storage-fs)             | Blob store on a local directory.                                                                                                      | Working |
| [`@mailless/transport-ses`](libs/transport-ses)       | Sends outgoing mail through Amazon SES.                                                                                               | Working |
| `@mailless/jmap-client`                               | Typed JMAP client.                                                                                                                    | Planned |

Also in this repository:

- [`apps/mailless-service`](apps/mailless-service): the Lambda functions: the
  SES ingest function, which imports inbound mail; the JMAP API; the function
  that records delivery, bounce and complaint reports; and the function that
  sends push notifications.
- [`apps/dev-server`](apps/dev-server): a small local JMAP server over
  in-memory storage for trying things out.
- [`infra/`](infra): Terraform for SES receiving, S3, DynamoDB and the ingest
  function. See its README before applying.

## Try it

Requires Node.js 22.12 or newer and pnpm. Tool versions are pinned in
`mise.toml`; with [mise](https://mise.jdx.dev) installed, `mise install` sets
up Node.js and Terraform.

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
`blobId` to `Email/import`. The dev server keeps everything in memory and
listens on localhost only. Besides the `dev` account, signing in over Basic
with any plain user name creates an empty account of that name.

## Development

Everything runs through Nx, which works out what each task needs first. The
common entry points are scripts in the root `package.json`:

| Command                                   | What it does                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm run check`                          | Lint, typecheck, Terraform validate, test and build, for every project. |
| `pnpm test`                               | All tests. Starts the local services first if they are not running.     |
| `pnpm build`                              | All builds, in dependency order.                                        |
| `pnpm lint` / `pnpm typecheck`            | Just those.                                                             |
| `pnpm format`                             | Format changed files.                                                   |
| `pnpm dev`                                | The local JMAP dev server.                                              |
| `pnpm infra plan`                         | Build the Lambda bundle and show what a deploy would change.            |
| `pnpm infra apply`                        | Build and deploy to AWS. See [`infra/`](infra) first.                   |
| `pnpm services:up` / `pnpm services:down` | Start or stop the local DynamoDB and S3 stand-ins.                      |

For one project or one task, call Nx directly: `pnpm nx test jmap-server`,
`pnpm nx graph`. Results are cached, so a task whose inputs have not changed
is not run again.

The storage adapter and ingest tests talk to DynamoDB Local and an S3 stand-in
from `docker-compose.yml`. Nx starts those containers before the tests that
need them, so Docker has to be available. When the test files are run without
Nx and the services are not there, those tests are skipped; set
`REQUIRE_LOCAL_SERVICES=1` (as CI does) to make that a failure.

`pnpm compliance` runs Fastmail's independent JMAP test suite against the dev
server and fails if something that passed before no longer does. It needs
Docker; see [`tools/compliance`](tools/compliance).

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
2. ~~DynamoDB, S3 and filesystem adapters; SES ingest function; Terraform~~
3. ~~JMAP API behind API Gateway with Cognito sign-in~~
4. ~~Composing and sending through SES~~
5. ~~Delivery, bounce and complaint reporting~~
6. App passwords (written, being tried out); multi-factor sign-in
7. `jmap-client`
8. ~~Push notifications through push subscriptions, full-text search,
   `/queryChanges`~~; push over WebSocket, first npm release
9. Self-hosted build with docker-compose

## License

[Apache-2.0](LICENSE)
