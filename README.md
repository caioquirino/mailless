# mailless

A mailbox without a mail server to run: serverless email on AWS, reached over
[JMAP](https://jmap.io) instead of IMAP, built from reusable TypeScript
libraries.

> **Status: usable every day, not yet released.** One deployment on real AWS
> carries its author's mail: receiving, reading, sending, contacts and a
> calendar, from the webmail here and from third-party JMAP apps. Every test
> of Fastmail's independent JMAP test suite passes. Nothing has been published
> to npm yet, and there is no self-hosted build yet. See
> [what is missing](#what-is-missing).

## Why JMAP

IMAP and POP3 are long-lived, stateful TCP protocols, which do not fit
request-based compute such as Lambda. JMAP (RFC 8620 and RFC 8621) is JSON over
HTTPS with batched calls and explicit state tokens for sync, so a mailbox can
be served by functions that only run while a request is in flight.

## What it does

**Mail on its way in.** SES accepts mail for the domain over TLS only (with
an MTA-STS policy published), checks it, and a function files it: a virus is
discarded, spam and mail that fails a strict DMARC policy go to Junk, mail
that only looks forged is delivered with a warning, and blocked senders go to
Junk. Then the account's own filters run. Details are in
[`infra/`](infra/README.md#what-is-done-about-unwanted-and-forged-mail).

**Mail on its way out.** Through SES, with delivery, bounce and complaint
reports recorded against the message; sending at a chosen time and "undo
send", waited for by the server; a vacation response; read receipts.

**Accounts and sign-in.** Accounts, their addresses, shares between them and
a size limit for each are managed in a web admin interface. Sign-in is on the
identity provider's pages (Amazon Cognito today, behind an interface), with
passkeys or a code from an authenticator app as each user's choice. Mail apps
get a password of their own each, shown once and revocable one by one.

**Filters.** One Sieve script for each account, run as mail arrives: file in
a folder, tag, mark read, star, discard. The webmail writes it from a form,
filter by filter, and leaves alone what was written by hand; either way it
can be tried on recent mail before it is saved.

**Contacts.** Address books of JSContact cards.

**Calendar.** Events that repeat, with one occurrence changed or the series
split from a date; reminders that reach the phone; invitations sent and
answered by mail, including another time proposed and an organiser's change
applied, tested against Gmail and Outlook; `.ics` files brought in and taken
out; and other people's calendars followed read-only from their `.ics`
address.

**Search.** Full text over headers, bodies and attachment names, with no
search service behind it: a record of each message's words, read at query
time. That costs nothing while idle and suits a personal mailbox.

**Push.** JMAP push subscriptions, and Web Push signed with VAPID for
browsers.

**The webmail** ([`apps/webmail`](apps/webmail)), a client of the JMAP API
like any other, in light and dark and on a phone:

- Conversations, folders and tags with a colour; several selected at once
  (with shift for a range); undo for what was just done.
- Writing in rich text with pictures in place, attachments uploaded in
  pieces, drafts kept by themselves, up to three messages open, a signature
  for each address.
- HTML mail shown in a sandbox with remote pictures held back until asked
  for, by message or always for a sender or a domain; turned dark with the
  page, with a button to see it as it was sent.
- Search typed (`from:`, `has:attachment`, `newer:1m`) or filled in as a form.
- Contacts, with the mail there has been with each person.
- A calendar by day, week, month or as an agenda, with events dragged to
  another time.
- Notifications that say who wrote, while a tab is open.

## JMAP compliance

`pnpm compliance` runs [Fastmail's JMAP-TestSuite](https://github.com/fastmail/JMAP-TestSuite),
written by other people from the RFCs, against the dev server. Every one of
its 166 test files passes, 1127 scenarios in all, none skipped, and CI fails
if one stops passing. See [`tools/compliance`](tools/compliance).

| Area of the suite                           |   Files | Scenarios |
| ------------------------------------------- | ------: | --------: |
| Core                                        |       6 |        30 |
| Mailbox                                     |      29 |       195 |
| Email                                       |      63 |       382 |
| Thread                                      |       7 |        30 |
| SearchSnippet                               |       2 |        11 |
| Identity                                    |       4 |        25 |
| EmailSubmission                             |       4 |        37 |
| VacationResponse                            |       3 |        15 |
| Blob                                        |       2 |        11 |
| Quota                                       |       3 |        27 |
| MDN                                         |       2 |        11 |
| Principal                                   |       3 |        36 |
| AddressBook                                 |       8 |        49 |
| ContactCard                                 |       9 |        91 |
| Calendar                                    |       7 |        39 |
| CalendarEvent                               |      10 |       112 |
| Others (previews, HTML bodies, old clients) |       4 |        26 |
| **Total**                                   | **166** |  **1127** |

What the server offers, by specification:

| Specification                                   | Capability                              | State                                                                                            |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RFC 8620, JMAP core                             | `urn:ietf:params:jmap:core`             | Complete except push over EventSource. `PushSubscription` is there.                              |
| RFC 8621, mail                                  | `urn:ietf:params:jmap:mail`             | Complete: `Mailbox`, `Thread`, `Email` (with `/copy`, `/import`, `/parse`), `SearchSnippet`.     |
| RFC 8621, submission                            | `urn:ietf:params:jmap:submission`       | Complete: `Identity`, `EmailSubmission`, with sending later and cancelling.                      |
| RFC 8621, vacation response                     | `urn:ietf:params:jmap:vacationresponse` | Complete.                                                                                        |
| RFC 9404, blob management                       | `urn:ietf:params:jmap:blob`             | `Blob/upload`, `/get`, `/lookup`, and `Blob/copy`.                                               |
| RFC 9425, quota                                 | `urn:ietf:params:jmap:quota`            | Complete; the limit is set per account by an administrator.                                      |
| RFC 9007, read receipts                         | `urn:ietf:params:jmap:mdn`              | `MDN/send`, `MDN/parse`.                                                                         |
| RFC 9670, sharing                               | `urn:ietf:params:jmap:principals`       | `Principal`, `ShareNotification`, `Principal/getAvailability`.                                   |
| RFC 9610, contacts                              | `urn:ietf:params:jmap:contacts`         | `AddressBook`, `ContactCard` (JSContact).                                                        |
| JMAP for Calendars (draft), JSCalendar RFC 8984 | `urn:ietf:params:jmap:calendars`        | `Calendar`, `CalendarEvent` (with `/copy`, `/parse`), reminders, scheduling by mail (iTIP/iMIP). |
| RFC 9661, Sieve scripts                         | `urn:ietf:params:jmap:sieve`            | `SieveScript/get`, `/changes`, `/set`, `/validate`, and `/test`. Sieve itself: see below.        |
| RFC 9749, VAPID for push                        | `urn:ietf:params:jmap:webpush-vapid`    | Complete.                                                                                        |
| RFC 8887, JMAP over WebSocket                   | `urn:ietf:params:jmap:websocket`        | Not there.                                                                                       |

The Sieve interpreter covers the base language (RFC 5228) with `fileinto`,
`imap4flags` (RFC 5232), `mailboxid` (RFC 9042) and `copy` (RFC 3894).
`redirect` is refused, since the server does not forward mail, and `discard`
moves a message to the Trash rather than losing it.

The test suite does not reach Sieve, share notifications or the capabilities
below; those are covered by this repository's own conformance tests, which
every storage adapter also runs.

Five capabilities are this project's own, under
`https://github.com/caioquirino/mailless/jmap/`. A client that does not know
them never names them and loses nothing:

| Capability               | Methods                                        | What for                                                        |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------- |
| `tags`                   | `Tag/get`, `/changes`, `/set`                  | A name and a colour for keywords of one's own.                  |
| `blocked-senders`        | `BlockedSender/get`, `/changes`, `/set`        | Addresses and domains whose mail goes to Junk.                  |
| `picture-senders`        | `PictureSender/get`, `/changes`, `/set`        | Senders and domains whose remote pictures are always shown.     |
| `calendar-proposals`     | `CalendarProposal/send`, `/decline`            | Another time proposed for an invitation, and the answer to one. |
| `calendar-subscriptions` | `CalendarSubscription/get`, `/add`, `/refresh` | A calendar followed read-only from its `.ics` address.          |

Where the RFCs allow more than one behaviour, the server does what other JMAP
servers do; the choices are listed in the
[`jmap-server` README](libs/jmap/server/README.md#choices-the-specification-leaves-open).

## What is missing

In the protocol:

- Push over EventSource and JMAP over WebSocket. Neither fits a function
  that ends with its request; EventSource is planned for the self-hosted
  build. Until then clients use push subscriptions or ask again.
- Forwarding from a filter (`redirect`), and the Sieve extensions not named
  above (`vacation`, `body`, `regex`, `variables` and others).
- CalDAV, CardDAV, IMAP and SMTP submission: JMAP is the only way in.

In the service:

- A self-hosted build. The libraries know no cloud and the pieces exist
  (filesystem blobs, DynamoDB Local), but the Node host, the SMTP listener
  and the container are not written.
- A first npm release. The release workflow is ready; nothing is published.
- Queries read every candidate record, one mailbox or the whole account.
  That suits a personal mailbox and will not scale to a very large one.
- A subscribed calendar is refreshed while someone has the calendar open, or
  on request, not on a schedule.
- A calendar followed through someone's account (Google or Microsoft sign-in)
  rather than its `.ics` address, and writing back to it.
- Only Amazon Cognito is implemented as an identity provider, and only SES
  as a transport.

In the webmail:

- Keyboard shortcuts.
- The mailboxes, contacts and calendars of other accounts shared with you.
  The server shares them; the webmail does not show them yet.
- A vacation response set from the settings.
- Contacts brought in from a file or taken out to one.
- Templates, and how far an attachment has got while it uploads.
- A notification that says who wrote when no tab is open.
- Working offline.
- For filters: how many messages each has filed.
- For calendar files: reminders are not carried in or out.

## Packages

The packages are in `libs/`, grouped by what they are about: `jmap`,
`storage`, `transport`, `directory`, `identity`, `admin` and `web`. Each group
holds what is neutral next to what implements it for one service. The ones
that are particular to AWS are tagged, and a lint rule keeps every other
library from depending on them, so that only an app chooses a cloud.

JMAP, from the protocol up:

| Package                                           | What it is                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`@mailless/jmap-core`](libs/jmap/core)           | Protocol types, validators, result references, patch objects and a Sieve parser and interpreter. No I/O; runs anywhere.         |
| [`@mailless/jmap-engine`](libs/jmap/engine)       | The engine: requests, sessions, accounts, blobs, push, the standard methods and the storage contract. Knows no kind of data.    |
| [`@mailless/jmap-mail`](libs/jmap/mail)           | Mail as a module: mailboxes, emails, threads, sending, search, vacation response, read receipts, quota, filters, tags, senders. |
| [`@mailless/jmap-contacts`](libs/jmap/contacts)   | Contacts as a module: address books and JSContact cards.                                                                        |
| [`@mailless/jmap-calendars`](libs/jmap/calendars) | Calendars as a module: JSCalendar events, repeats, reminders, scheduling by mail, iCalendar in and out, subscriptions.          |
| [`@mailless/jmap-sharing`](libs/jmap/sharing)     | Sharing as a module: principals and share notifications.                                                                        |
| [`@mailless/jmap-server`](libs/jmap/server)       | The four modules assembled on the engine, with the conformance suite every storage adapter runs.                                |
| [`@mailless/jmap-client`](libs/jmap/client)       | Typed JMAP client: session, batched calls with back-references, a local copy kept in step, blobs. Depends on `jmap-core` alone. |

Storage and transport:

| Package                                               | What it is                                      |
| ----------------------------------------------------- | ----------------------------------------------- |
| [`@mailless/storage-dynamodb`](libs/storage/dynamodb) | Metadata store on DynamoDB (or DynamoDB Local). |
| [`@mailless/storage-s3`](libs/storage/s3)             | Blob store on S3 or an S3-compatible server.    |
| [`@mailless/storage-fs`](libs/storage/fs)             | Blob store on a local directory.                |
| [`@mailless/transport-ses`](libs/transport/ses)       | Sends outgoing mail through Amazon SES.         |

Accounts, sign-in and administration:

| Package                                                   | What it is                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`@mailless/directory`](libs/directory/core)              | Who has a mailbox: accounts, their addresses and who they are shared with.                    |
| [`@mailless/directory-dynamodb`](libs/directory/dynamodb) | The directory on DynamoDB (or DynamoDB Local).                                                |
| [`@mailless/identity`](libs/identity/core)                | Verifies the tokens of any OpenID Connect provider, and the interface for managing its users. |
| [`@mailless/identity-cognito`](libs/identity/cognito)     | Amazon Cognito as the identity provider.                                                      |
| [`@mailless/app-passwords`](libs/identity/app-passwords)  | A password of its own for each mail app: made once, stored as hashes, revocable one by one.   |
| [`@mailless/admin-api`](libs/admin/api)                   | The administration API: accounts for administrators, and each user's own credentials.         |
| [`@mailless/admin-client`](libs/admin/client)             | Typed client for it, generated from its OpenAPI document.                                     |

For a browser:

| Package                                     | What it is                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`@mailless/web-session`](libs/web/session) | Sign-in for a web application in a browser: OpenID Connect with PKCE, tokens kept for the tab and renewed. |
| [`@mailless/ui`](libs/web/ui)               | The design system: tokens in light and dark, base styles, a theme switch and React components.             |

All of them work and are tested; none is on npm yet.

Applications, which are not published:

- [`apps/mailless-service`](apps/mailless-service): the Lambda functions.
  One imports inbound mail from SES; one serves the JMAP API; one records
  delivery, bounce and complaint reports; one sends push notifications and
  calendar reminders; one sends held messages when their time comes; one
  removes the mail of a closed account; and the rest serve the admin API,
  the admin interface and the webmail.
- [`apps/webmail`](apps/webmail): the webmail, a React app served under
  `/mail/`.
- [`apps/admin-web`](apps/admin-web): the admin interface, a React app
  served under `/admin/`. Users change their password and manage their
  passkeys, authenticator app and app passwords; administrators manage
  accounts.
- [`apps/dev-server`](apps/dev-server): a small local JMAP server over
  in-memory storage for trying things out, and what the compliance suite
  runs against.
- [`infra/`](infra): Terraform for all of it on AWS: SES in and out, S3,
  DynamoDB, the functions, API Gateway, Cognito, DNS and MTA-STS. See its
  README before applying.
- [`tools/compliance`](tools/compliance): the compliance run.

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

Lint enforces the dependency direction between projects: `jmap-core` depends
on nothing, `jmap-engine` on the core, each module (mail, contacts, calendars,
sharing) on those two, and `jmap-server` puts them together. `jmap-client`
depends on the core alone. No library depends on one that is particular to
AWS, and libraries never import apps.

## Design in one paragraph

All JMAP behaviour (filters, sorting, threading, mailbox counts, change
tracking) lives in the `jmap` libraries: an engine that knows the protocol
and no kind of data, and one module for each kind. Storage backends implement
a small contract: versioned records, secondary-index lookups, one atomic
batch write, atomic counters, a change log, and a blob store. That keeps
adapters short and lets every adapter be checked by the same exported
conformance suite. Metadata goes to a database (DynamoDB on AWS) and message
content to blob storage (S3); the HTTP host (Lambda, or a plain Node server
for self-hosting) is a thin wrapper around `handleRequest`. What touches the
outside world (sending, signing in, fetching a subscribed calendar) is handed
to the server by the app, so the libraries carry no cloud SDK.

## Roadmap

Done: the JMAP libraries and their storage adapters; receiving and sending
through SES with delivery reports; sign-in with passkeys and a second step;
app passwords; the admin interface; the client library; push subscriptions;
full-text search; the webmail; contacts; calendars with invitations; filters.

Next, in no fixed order:

1. First npm release of the libraries.
2. Self-hosted build with docker-compose, with push over EventSource.
3. In the webmail: keyboard shortcuts, shared accounts, the vacation response.
4. Calendars followed through a Google or Microsoft account.

## Releasing

The libraries are versioned one by one, from the commit messages
(conventional commits), and published to npm from CI.

```sh
pnpm release --dry-run   # what would change: versions, changelogs, tags
pnpm release             # do it: builds from nothing, commits and tags
git push --follow-tags
```

Then start the "Publish" workflow on GitHub. It builds from nothing and
publishes the versions that are in the repository, with provenance, leaving
alone any that npm already has. It is a dry run unless told otherwise, and
needs an `NPM_TOKEN` secret that may publish to the `@mailless` scope. For
the very first release, add `--first-release` to `pnpm release` and tick the
box of the same name in the workflow.

## License

[Apache-2.0](LICENSE)
