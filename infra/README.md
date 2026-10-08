# Infrastructure

Terraform for the AWS side of mailless: receiving mail through SES, storing it
in S3 and DynamoDB, serving it to mail clients over a JMAP API, and sending
through SES.

> **Receiving, reading and sending are proven; delivery reporting is new.**
> Inbound delivery, the JMAP API with Cognito sign-in, and sending through SES
> have all been confirmed on a real account. Delivery, bounce and complaint
> reporting passes its tests and a real `plan`, but has not processed a real
> SES event yet.

## What it creates

| Resource                                                 | Purpose                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SES domain identity with DKIM                            | Proves ownership of the domain.                                                                                                                         |
| SES receipt rule set and rule                            | Accepts mail for the domain over TLS, scans it, stores it in S3, then invokes the ingest function.                                                      |
| S3 bucket                                                | `inbound/` holds raw messages until imported; `blobs/` holds the mailbox content. Encrypted, private, TLS only.                                         |
| DynamoDB table                                           | Mailbox metadata and change log. On-demand billing, point-in-time recovery, deletion protection.                                                        |
| Ingest Lambda (`nodejs24.x`, arm64)                      | Imports each message into the recipients' accounts.                                                                                                     |
| SQS dead-letter queue                                    | Catches deliveries that still fail after two retries.                                                                                                   |
| KMS key (optional, on by default)                        | Customer-managed encryption for the bucket and table.                                                                                                   |
| Cognito user pool                                        | Who may sign in: one user per account id in `mailboxes`. Sign-up is closed. A password or, once enrolled, a passkey.                                    |
| Sign-in pages, admin client and `MAILLESS_ADMIN` group   | Cognito's own pages for signing in and enrolling a passkey, on `auth.<domain>` with Route53, for the admin interface and those who may manage accounts. |
| API Lambda and HTTP API                                  | The JMAP endpoints, throttled, with access logs that hold no credentials or content.                                                                    |
| Admin Lambda and its route                               | The admin API under `/admin/api`: accounts, addresses and shares, and each user's own credentials. It can change accounts and cannot read mail.         |
| Certificate and `mail.<domain>` (with Route53)           | The API's own hostname, plus an SRV record so clients can find it from an address.                                                                      |
| MAIL FROM subdomain                                      | `bounce.<domain>` as the envelope sender of outgoing mail, so SPF passes for your own domain.                                                           |
| SES configuration set, SNS topic, delivery events Lambda | Every sent message reports back: delivered, bounced, delayed, rejected or complained about. The outcome is recorded on the sent message.                |
| Table stream and push Lambda                             | Tells mail apps that registered for it when something changed, so new mail shows up without refreshing.                                                 |
| Send queue, schedule group and send Lambda               | Holds messages to send later, and wakes up to send them. Used by "undo send".                                                                           |
| CloudWatch alarms                                        | Bounce rate, complaint rate, and anything left in a dead-letter queue.                                                                                  |
| Route53 records (optional)                               | Inbound MX, three DKIM CNAMEs, the MAIL FROM records and a DMARC record, when the domain's zone is in Route53.                                          |

Everything is pay-per-use except the KMS key, which costs about 1 USD a month.
Set `use_customer_kms_key = false` to use the free AWS-managed encryption.

## Sending

Each account may send from the addresses that deliver to it. With a
`*@<domain>` entry in `mailboxes`, that is any address at the domain.

- **Sandbox.** A new SES account can only send to verified addresses, 200
  messages a day. Your own domain is verified, so mail to any address at it
  works straight away, which is enough to test. To send to anyone else, ask
  AWS for production access (SES console, "Request production access");
  approval usually takes about a day.
- **Authentication.** Outgoing mail is DKIM-signed for your domain and uses
  `bounce.<domain>` as its envelope sender, so both DKIM and SPF align.
- **DMARC.** A `_dmarc` record with policy `quarantine` is published by
  default. It tells receivers to distrust mail claiming to be from your domain
  that fails authentication. If the domain also sends through another service
  that does not sign with DKIM, set `dmarc_policy = "none"` or `null` first,
  or that mail may land in spam.
- **Bounces and complaints.** Mail is sent through a configuration set that
  reports what became of each message. The outcome per recipient is stored on
  the sent message as its JMAP `deliveryStatus`, where a client can show it.
  Addresses that hard-bounce or complain go on the SES suppression list and
  are not sent to again. Complaints are logged and counted.
- **Alarms** fire when the bounce rate passes 4% or the complaint rate 0.08%,
  just below the levels at which SES puts an account under review, and when a
  message or delivery report could not be processed. Set `alarm_email` to be
  emailed (AWS sends a confirmation link first); otherwise they are visible in
  CloudWatch only.
- **Not handled yet:** there is no outbound rate limiting beyond SES's own,
  and a bounce is not turned into a message in the inbox (SES's own bounce
  notification email still arrives there).

## Before you apply

- **Region**: SES must support email receiving in it.
- **Active receipt rule set**: SES has one active rule set per region and
  account. `activate_receipt_rule_set = true` replaces whichever is active
  now. Leave it `false` for the first apply if the account already receives
  mail through SES, and check first.
- **Recipients**: only addresses listed in `mailboxes` are delivered. Mail to
  any other address at the domain is accepted and then dropped, without a
  bounce.
- **Deletion**: the bucket and the table have `prevent_destroy`, and the table
  has deletion protection. `terraform destroy` will refuse until you remove
  those on purpose.

## Deploying

Tool versions come from `mise.toml` at the repository root (`mise install`).
You need AWS credentials in the environment.

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars   # region, domain, mailboxes
pnpm infra plan     # show what would change
pnpm infra apply    # deploy; Terraform shows the plan and waits for "yes"
```

`plan` and `apply` are Nx tasks with everything they need declared as
dependencies, so each run does the following, skipping what is already done:

| Step                                  | What it does                                                   |
| ------------------------------------- | -------------------------------------------------------------- |
| `infra:validate`                      | Checks the Terraform configuration. Cached.                    |
| library and `mailless-service` builds | Produces the Lambda bundle. Cached.                            |
| `infra:init`                          | Finds or creates the state bucket, then runs `terraform init`. |
| `infra:plan` / `infra:apply`          | The Terraform command itself.                                  |

`pnpm infra` on its own lists the available tasks.

### Terraform state

State lives in an S3 bucket named
`<name>-terraform-state-<account id>-<region>`, with S3-native locking. You do
not create it: `infra:init` ([`scripts/init.mjs`](scripts/init.mjs)) looks up
the account you are signed in to, and

- if this checkout is already initialised against that bucket, goes straight
  to `terraform init` without asking AWS about the bucket again;
- otherwise checks whether the bucket exists, creates it if not, and makes
  sure it is private, versioned, encrypted and TLS-only.

Signing in to a different account or changing the region selects a different
bucket, and Terraform is re-initialised against it. The bucket is deliberately
not managed by Terraform itself, so there is no second state file to look
after.

### DNS

If the domain is not in Route53, add the records from the `dns_records` output
at your DNS provider. SES verifies the domain once the DKIM records resolve,
and mail starts arriving once the MX record does and the rule set is active.

`terraform.tfvars` is ignored by git: it holds your domain and addresses.

## Signing in and connecting a mail client

Each account id in `mailboxes` gets a sign-in of the same name (the `users`
output lists them). Set its password once:

```sh
pnpm infra password <name>
```

The password is typed at a hidden prompt and goes straight to Cognito; it is
never an argument, and never in Terraform state. It must be at least 14
characters.

Then point a JMAP client at the `api_url` output (`https://mail.<domain>` with
Route53), or, where the client supports discovery, just give it an address at
the domain. Sign in with the name and password.

```sh
curl -u <name> https://mail.example.com/.well-known/jmap
```

You can type either the name or any email address that delivers to the
account; an address is mapped to its account.

### App passwords

Rather than giving a mail client your real password, give each one its own:

```sh
pnpm infra app-password create "Mailtemi on phone"
pnpm infra app-password list
pnpm infra app-password revoke <id>
```

`create` prints a long random password once. Enter it in the client, with your
email address, in place of your real password. Only a hash is stored, so it
cannot be shown again; make a new one if it is lost. `list` shows each
password's label, when it was created and when it was last used (to the hour).
Revoking one signs that client out within a minute and affects nothing else.

Once every client uses an app password, set this in `terraform.tfvars` and
apply:

```hcl
allow_password_sign_in = false
```

Mail clients can then no longer sign in with the account password at all, so a
lost or compromised device never holds it. The account password remains what
`pnpm infra password` sets, and is still what issues bearer tokens.

These commands need your AWS credentials: app passwords are created from the
command line, not through the API, so nothing reachable from the internet can
mint one.

### Sign-in pages and passkeys

Besides the password a mail client checks, the stack has Cognito's own sign-in
pages, which the admin interface uses. They are where a passkey is enrolled
and used. `terraform output auth` gives their addresses.

- With `route53_zone_id` set, the pages are on `auth.<domain>` (change it with
  `auth_hostname`). Cognito refuses a hostname whose parent domain has no A
  record, so `example.com` itself must have one before `auth.example.com` can
  be made. Passkeys are bound to the mail domain, so they keep working if the
  hostname changes later.
- Without a zone, the pages are on a hostname Cognito provides and passkeys
  are bound to that hostname. Moving to a hostname of your own later means
  every passkey has to be enrolled again.

Members of the `MAILLESS_ADMIN` group may manage accounts in the admin
interface. The first administrator is made from here:

```sh
pnpm infra admin grant <account>
pnpm infra admin list
pnpm infra admin revoke <account>   # also ends that user's sessions
```

To run that interface on your own machine against this stack, allow
it to be signed in to from there:

```hcl
admin_extra_callback_urls = ["http://localhost:5173/admin/callback"]
```

All of this is in `modules/identity-cognito`. The rest of the stack reads only
that module's outputs, so signing in with another provider is another module
with the same outputs.

### The admin API

Accounts, addresses and shares for administrators, and each user's own
password, passkeys and app passwords, are managed through an API of its own
at `terraform output admin_api_url` (`<API address>/admin/api`). What it
offers is described in
[`libs/admin-api/openapi.json`](../libs/admin-api/openapi.json).

- Every call needs an access token from the sign-in pages, issued for the
  admin client. The gateway checks it before anything runs, and the function
  checks it again. A token a mail client holds is not accepted.
- Everything under `/accounts` needs the `MAILLESS_ADMIN` role.
- It runs as a function of its own. That function can change the directory,
  the users of the pool and app passwords. It has no access to the bucket and
  cannot send mail, and in the table that holds mail it can reach only the
  app-password entries and the counters that record that something changed.

### The accounts directory

Who has a mailbox, which addresses deliver to it and who it is shared with is
kept in a table of its own, which the functions that handle mail may read and
nothing more. Today it is filled from `terraform.tfvars`:

```sh
pnpm infra directory seed   # copy mailboxes, account_names and shared_accounts into the table
pnpm infra directory show   # list what the table holds
```

`seed` only adds, so it can be run as often as you like. It then checks that
every configured address delivers to the same account in the table, and says
so where the two differ instead of replacing anything. Run it after each
`pnpm infra apply` that changed the accounts.

What the table does not have is still taken from `terraform.tfvars`, so mail
keeps arriving whether or not the table has been filled. A log line
`directory-fallback` says when that happened.

Account ids are small letters, digits, `-` and `_`. A user whose account is
`disabled` in the directory cannot sign in; mail for it still arrives.

### Push notifications

A mail app that supports JMAP push registers a push subscription when it signs
in; there is nothing to configure. From then on, every change to the mailbox
is reported to the app's push service within a second or two, and the app
fetches what changed.

- A push says which kinds of data changed (for example `Email`,
  `EmailDelivery`) and their new state strings. It never contains addresses,
  subjects or content, and it is encrypted when the app supplies keys.
- The push function only connects to `https` addresses with public host names,
  and only after the app has proved it receives what is sent there.
- Subscriptions last at most 30 days unless the app renews them, and an
  account can hold 16.
- The function logs the kinds of data and counts only:
  `{"event":"push","types":["Email","EmailDelivery","Thread"],"sent":1,"failed":0,"removed":0}`
  in `/aws/lambda/<name>-push`. `sent` staying at 0 means no app has a verified
  subscription.

### Shared accounts

An account can be used by more than its own user, which is how a shared
mailbox works. In `terraform.tfvars`:

```hcl
mailboxes       = { "ann@example.com" = "ann", "bob@example.com" = "bob", "team@example.com" = "team" }
shared_accounts = { team = { members = ["ann", "bob"] } }
```

Ann and Bob each sign in as themselves and see the team mailbox next to their
own in a mail app that supports several accounts. `members` may read, file,
delete and send as the team's addresses; `readers` may only read. Mail can be
copied or moved between a user's own account and a shared one. New mail in a
shared account does not trigger push notifications for its members.

### Sending later and "undo send"

A mail app that supports it can hold a message: for a few seconds, giving you
time to take it back, or until a date. Nothing runs while a message waits.

- A delay of up to 15 minutes is a delayed queue message, and goes out to the
  second.
- A longer one, up to 30 days, is a one-time schedule, and goes out within a
  minute of its time.
- A message that could not be sent when due is retried, and ends up in the
  queue named by the `send_dead_letter_queue` output if it keeps failing. An
  alarm watches that queue. It should stay empty.
- The log `/aws/lambda/<name>-send` records each wake-up by submission id and
  outcome: `sent`, `not-pending` for a message cancelled in the meantime, or
  `rejected` when SES refused it.

### Quota

By default a mailbox has no limit. To give each account one:

```hcl
account_quota_bytes = 5368709120 # 5 GB
```

Mail apps that support it then show how full the mailbox is. Once it is full
you cannot add mail to it yourself (saving a draft, importing), but mail
arriving from outside is always delivered.

### Read receipts

When someone asks for a read receipt, a mail app that supports it can send
one. A receipt goes only to the address the message itself named for it, and
each message is answered at most once.

### Vacation response

A mail app that supports it can turn on an out-of-office reply for the
account. While it is on, the ingest function answers incoming mail once per
sender per week, following the usual rules for automatic replies: nothing goes
to mailing lists, bounces, automatic senders, junk, or mail not addressed to
you.

- Replies are sent as the address the message was written to, through the
  same configuration set as other mail, so bounced addresses are not written
  to again.
- While SES is in the sandbox, replies to unverified addresses are refused by
  SES. The mail is still delivered; the log shows
  `{"event":"auto-reply","outcome":"failed"}`.
- The ingest log records each decision by name only, such as `sent` or
  `mailing-list`, never who wrote.

### What is accepted

- **Email address or name, with an app password** (HTTP Basic). The
  recommended way for mail clients.
- **Email address or name, with the account password** (HTTP Basic), unless
  `allow_password_sign_in` is false.
- **Bearer token**: a Cognito access token for this user pool.

Things to know:

- **No multi-factor authentication yet.** With `allow_password_sign_in =
false` and app passwords in clients, the account password is only used to
  obtain tokens, which is what makes adding it possible later.
- **Sizes.** A request body can be at most 5 MB and an upload 4 MB, because of
  Lambda's limits. Downloads have no such limit: large ones are redirected to
  a private, signed S3 link that is valid for five minutes.
- **Without Route53** there is no `mail.<domain>`: the API is served on the
  address API Gateway generates, shown in `api_url`.

## Checking it works

After sending a test message to one of the configured addresses:

```sh
aws logs tail /aws/lambda/mailless-ingest --since 10m
# {"messageId":"...","outcome":"delivered"}
```

The logs carry SES message ids and outcomes only, never addresses or content.
The dead-letter queues (`ingest_dead_letter_queue`,
`events_dead_letter_queue` and `push_dead_letter_queue` outputs) should stay
empty. Delivery reports are
logged in `/aws/lambda/<name>-delivery-events`, again without addresses.
API requests appear in `/aws/apigateway/<name>` (route, status, timing) and
errors in `/aws/lambda/<name>-api`.

## Tests

```sh
pnpm nx run-many -t lint validate test -p infra
```

`pnpm run check` at the repository root includes these.

`test` runs `tests/stack.tftest.hcl` with a mocked provider, so it needs no
credentials and creates nothing. It checks the conditional DNS records and rule
set activation, the encryption toggle, that the function's role has no
wildcard actions or resources, that SES access to the bucket and function is
tied to this account and receipt rule, that sign-up is closed, that only the
JMAP routes are exposed, and that malformed input is rejected.
It also runs the unit tests of the state bucket script.

`pnpm run check` at the repository root includes all of these.
