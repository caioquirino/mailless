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

| Resource                                                 | Purpose                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SES domain identity with DKIM                            | Proves ownership of the domain.                                                                                                                                                   |
| SES receipt rule set and rule                            | Accepts mail for the domain over TLS, scans it, stores it in S3, then invokes the ingest function.                                                                                |
| S3 bucket                                                | `inbound/` holds raw messages until imported; `blobs/` holds the mailbox content. Encrypted, private, TLS only.                                                                   |
| DynamoDB table                                           | Mailbox metadata and change log. On-demand billing, point-in-time recovery, deletion protection.                                                                                  |
| Ingest Lambda (`nodejs24.x`, arm64)                      | Imports each message into the recipients' accounts.                                                                                                                               |
| SQS dead-letter queue                                    | Catches deliveries that still fail after two retries.                                                                                                                             |
| KMS key (optional, on by default)                        | Customer-managed encryption for the bucket and table.                                                                                                                             |
| Cognito user pool                                        | Who may sign in: one user per account, made in the admin interface. Sign-up is closed. A password or, once enrolled, a passkey.                                                   |
| Sign-in pages, admin client and `MAILLESS_ADMIN` group   | Cognito's own pages for signing in and enrolling a passkey, on `auth.<domain>` with Route53, for the admin interface and those who may manage accounts.                           |
| API Lambda and HTTP API                                  | The JMAP endpoints, throttled, with access logs that hold no credentials or content.                                                                                              |
| Admin Lambda and its routes                              | The admin interface under `/admin/` and its API under `/admin/api`: accounts, addresses and shares, and each user's own credentials. It can change accounts and cannot read mail. |
| Webmail Lambda, client and routes                        | The webmail under `/mail/`: mail in a browser. The function hands out the pages and can reach nothing else; the pages reach mail through the JMAP API.                            |
| Certificate and `mail.<domain>` (with Route53)           | The API's own hostname, plus an SRV record so clients can find it from an address.                                                                                                |
| MAIL FROM subdomain                                      | `bounce.<domain>` as the envelope sender of outgoing mail, so SPF passes for your own domain.                                                                                     |
| SES configuration set, SNS topic, delivery events Lambda | Every sent message reports back: delivered, bounced, delayed, rejected or complained about. The outcome is recorded on the sent message.                                          |
| Table stream and push Lambda                             | Tells mail apps that registered for it when something changed, so new mail shows up without refreshing.                                                                           |
| Send queue, schedule group and send Lambda               | Holds messages to send later, and wakes up to send them. Used by "undo send".                                                                                                     |
| Purge queue and purge Lambda                             | Removes the mail of an account closed in the admin interface, then the account itself, which frees its id.                                                                        |
| CloudWatch alarms                                        | Bounce rate, complaint rate, and anything left in a dead-letter queue.                                                                                                            |
| Route53 records (optional)                               | Inbound MX, three DKIM CNAMEs, the MAIL FROM records and a DMARC record, when the domain's zone is in Route53.                                                                    |

Everything is pay-per-use except the KMS key, which costs about 1 USD a month.
Set `use_customer_kms_key = false` to use the free AWS-managed encryption.

## Sending

Each account may send from the addresses that deliver to it. An account with
a whole-domain address (`*@<domain>`) may send from any address at the domain.

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
- **Reports.** Set `mail_report_address` to be told, once a day by each large
  mail service, who sent mail in your domain's name and whether it passed
  (DMARC), and how delivery to you over TLS went. The reports are files for a
  program to read, so give an address kept for them. Nothing is asked for
  until you do.
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
- **Recipients**: only addresses given to an account are delivered. Mail to
  any other address at the domain is accepted and then dropped, without a
  bounce.
- **Deletion**: the bucket and the table have `prevent_destroy`, and the table
  has deletion protection. `terraform destroy` will refuse until you remove
  those on purpose.

## Deploying

Tool versions come from `mise.toml` at the repository root (`mise install`).
You need AWS credentials in the environment.

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars   # region, domain
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

### When a run is cut short

Terraform locks the state while it changes it. A run that is interrupted, or
loses its connection, can leave the lock behind, and the next run then stops
with "Error acquiring the state lock".

```sh
pnpm infra state show     # whether the state is locked, by whom and since when
pnpm infra state unlock   # shows the same, asks, then removes the lock
```

Remove a lock only when the run that holds it is over: unlocking under a run
that is still going lets two change the state at once. A run that changed
things and could not save the state leaves `infra/errored.tfstate`; both
commands say so, and how to save it.

A new deployment has no accounts. Make the first one, whose user may
administer the rest, and give it a password:

```sh
pnpm infra admin create <account>   # small letters, digits, - and _
pnpm infra password <account>
```

Then sign in to the admin interface (`terraform output admin_url`) and add
the addresses that deliver to the account. Every other account, address and
share is made there too.

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

Every account has a user of the same name. Its password opens the admin
interface, where the user manages their own password, passkeys and app
passwords. An administrator sets a new user's first password there;
`pnpm infra password <account>` does the same from the command line, for the
first account or for an administrator who is locked out. The password is
typed at a hidden prompt and goes straight to Cognito; it is never an
argument, and never in Terraform state. It must be at least 14 characters.

A mail client never gets that password. It signs in with an app password.

### App passwords

Each mail client gets a password of its own, made in the admin interface
under "My account", or from the command line:

```sh
pnpm infra app-password create "Mailtemi on phone" [--account <account>]
pnpm infra app-password list
pnpm infra app-password revoke <id>
```

The long random password is shown once. Enter it in the client, with your
email address or account name. Only a hash is stored, so it cannot be shown
again; make a new one if it is lost. The list shows each password's label,
when it was created and when it was last used (to the hour). Revoking one
signs that client out within a minute and affects nothing else.

Point the client at the `api_url` output (`https://mail.<domain>` with
Route53), or, where the client supports discovery, just give it an address at
the domain.

```sh
curl -u <account> https://mail.example.com/.well-known/jmap   # asks for an app password
```

The account's own password is not accepted here, whatever is configured: a
lost or compromised device never holds it.

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

A second step is there for whoever wants one: a six-digit code from an
authenticator app, asked for after the password. Each user turns it on for
themselves in the admin interface, under "My account", where the code to scan
is shown: the sign-in pages ask for the code and do not offer to set it up.
While it is on, that user signs in by password and code, and is not offered
their passkeys. Mail apps are not affected: they use app passwords.

Members of the `MAILLESS_ADMIN` group may manage accounts in the admin
interface. The first administrator is made from here, and so is anyone who
has to be let back in when no administrator can sign in:

```sh
pnpm infra admin create <account>   # a new account whose user may administer
pnpm infra admin grant <account>    # the same for an account that exists
pnpm infra admin list
pnpm infra admin revoke <account>   # also ends that user's sessions
```

The interface itself is described [below](#the-admin-interface-and-its-api).

All of this is in `modules/identity-cognito`. The rest of the stack reads only
that module's outputs, so signing in with another provider is another module
with the same outputs.

### The admin interface and its API

Accounts, addresses and shares for administrators, and each user's own
password, passkeys and app passwords, are managed in a web interface at
`terraform output admin_url` (`<API address>/admin/`). Anyone with an account
can sign in to it for their own credentials. Managing accounts needs the
`MAILLESS_ADMIN` role, and the first administrator is made with
`pnpm infra admin create <account>`.

The pages themselves are public, as the files of any web application are.
Everything they do goes through an API at `terraform output admin_api_url`
(`<API address>/admin/api`), and that needs a sign-in. What the API offers is
described in [`libs/admin/api/openapi.json`](../libs/admin/api/openapi.json).

- Every call needs an access token from the sign-in pages, issued for the
  admin client. The gateway checks it before anything runs, and the function
  checks it again. A token a mail client holds is not accepted.
- Everything under `/accounts` needs the `MAILLESS_ADMIN` role.
- It runs as a function of its own. That function can change the directory,
  the users of the pool and app passwords. It has no access to the bucket and
  cannot send mail, and in the table that holds mail it can reach only the
  app-password entries and the counters that record that something changed.

Closing an account stops it at once, and its mail is removed a couple of
minutes later by a function of its own, the only one that may empty a
mailbox. It can list and remove stored mail but not read a message, and it
removes nothing unless the directory says the account is closed. The account
stays listed as closed until nothing of it is left; then it disappears and
its id can be used again. A large mailbox takes several runs. Each run logs
the account id and how it ended in `/aws/lambda/<name>-purge`, and a removal
that keeps failing lands in the queue named by the `purge_dead_letter_queue`
output and raises an alarm; "Remove mail again" on the closed account's page
retries it.

To work on the interface on your own machine against this stack, let it be
signed in to from there, apply, and then start it with the stack as its
backend:

```hcl
admin_extra_callback_urls = ["http://localhost:5173/admin/callback"]
```

```sh
ADMIN_BACKEND=https://<API hostname> pnpm nx dev admin-web
```

The pages then come from your machine and everything else from the stack.

### How large an attachment may be

A message may carry about 28 MB of attachments. Amazon SES carries 40 MB a
message, counted after attachments are encoded for mail, which makes them a
third larger. A recipient's own server may refuse less: 20 to 25 MB is
common.

One upload to the API holds 4 MB, which is what fits in a call to a
function. A mail app sends a larger file in pieces and has the server join
them, with `Blob/upload` (RFC 9404); the session says how much may be joined
(`maxSizeBlobSet`) and how much a message may carry
(`maxSizeAttachmentsPerEmail`). The webmail does this by itself. A mail app
that does not is held to 4 MB a file.

### The domain's logo

Some mail programs show a logo beside a sender's mail (BIMI). To publish
yours, give the path of the file:

```hcl
bimi_logo = "logo.svg"
```

The stack then hands the file out at `/bimi/logo.svg` and adds the DNS
record that says so (`default._bimi`), which is among `dns_records` when the
DNS is kept elsewhere. Nobody else is involved and nothing is paid for. The
file is an SVG in the profile BIMI asks for (SVG Tiny PS: square, no
scripts, nothing fetched from outside the file, 32 KB at most), and
`dmarc_policy` must be `quarantine` or `reject`.

No certificate is published with it. Mail services that show a logo
without one, Yahoo and Fastmail among them, show this; Gmail and Apple Mail
ask for a certificate bought from an authority, and show nothing without.

### What happens to an upload

A file a client uploads is there for a message to be made of it, and the
message keeps a copy of its own. The upload itself, the pieces of a large
file and the file joined from them are removed after
`upload_retention_days` (two by default), by a rule on the bucket that
costs nothing to run. Nothing that is part of a message is touched by it,
and an upload something relies on directly, such as the photo of a contact,
stays. Uploads made before this rule existed carry no mark and are not
removed by it.

### The webmail

Mail in a browser, at `terraform output webmail_url` (`<API address>/mail/`),
for anyone with an account. The site's own address leads there.

- It is a client of the JMAP API like any mail app: it has no API of its own
  and nothing it can do that a mail app cannot.
- Signing in is on the sign-in pages, as for the admin interface, with a
  client of its own. The JMAP API accepts tokens issued for it; the admin API
  does not, and a token of the admin interface does not open mail.
- The function that serves it hands out the pages and may write its own log.
  It has no access to the bucket, the tables, the pool or anything else.
- A message written in HTML is shown in a frame where no script runs, and
  pictures kept on other sites are not loaded until the reader asks: loading
  one tells its sender that the message was opened, and from where.

To work on it on your own machine against this stack:

```hcl
webmail_extra_callback_urls = ["http://localhost:5174/mail/callback"]
```

```sh
MAIL_BACKEND=https://<API hostname> pnpm nx dev webmail
```

### The accounts directory

Who has a mailbox, which addresses deliver to it and who it is shared with is
kept in a table of its own. The admin interface changes it; the functions
that handle mail may read it and nothing more, and remember what it said for
a minute, so a change takes that long to reach them.

```sh
pnpm infra directory show   # list the accounts, their addresses and who they are shared with
```

Account ids are small letters, digits, `-` and `_`. A user whose account is
`disabled` in the directory cannot sign in; mail for it still arrives.

Deployments made before the admin interface kept accounts in
`terraform.tfvars` (`mailboxes`, `account_names`, `shared_accounts`,
`allow_password_sign_in`). Those settings no longer exist: remove them from
the file, or Terraform warns about each. The users they made stay as they
are; Terraform only stops keeping track of them.

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
- Every push is signed (VAPID, RFC 8292), and the session offers the public
  key (RFC 9749), which browsers and the large push services require. The key
  pair is made by the API function the first time it starts and kept as the
  encrypted parameter `/<name>/vapid-keys`. It is in neither the
  configuration nor Terraform's state, and `terraform destroy` leaves it.
  Do not delete or replace it: every push subscription made with it would
  end, and each app would have to subscribe again.
- The function logs the kinds of data and counts only:
  `{"event":"push","types":["Email","EmailDelivery","Thread"],"sent":1,"failed":0,"removed":0}`
  in `/aws/lambda/<name>-push`. `sent` staying at 0 means no app has a verified
  subscription.

### Calendar reminders

An event's reminders are told to the account's devices by the same function
that tells them of new mail. Nothing runs while nothing is due: each account
that has events has one schedule in EventBridge Scheduler, set for its next
reminder. When it fires, the function pushes what is due and sets the
schedule for the one after; whenever the account's calendar changes, it is
set again. A reminder reaches the browsers and phones where notifications
were turned on in the webmail, as a notification that names the event and
says how soon it is. One that could not be told of within fifteen minutes is
dropped: by then it would only confuse.

### Shared accounts

An account can be used by more than its own user, which is how a shared
mailbox works. In the admin interface, make an account `team`, give it its
address, and share it with `ann` and `bob`.

Ann and Bob each sign in as themselves and see the team mailbox next to their
own in a mail app that supports several accounts. Members may read, file,
delete and send as the team's addresses; readers may only read. Mail can be
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

An administrator gives an account a limit of its own on the account's page
in the admin interface, under "Mailbox size". It reaches the mail functions
within a minute.

An account without one gets what every account gets, which by default is no
limit. To set that:

```hcl
account_quota_bytes = 5368709120 # 5 GB
```

Mail apps that support it then show how full the mailbox is. Once it is full
you cannot add mail to it yourself (saving a draft, importing), but mail
arriving from outside is always delivered.

The admin interface shows how full each mailbox is, against the limit when
there is one: to each user for their own, and to administrators for every
account. The admin function reads the counter only, never the mail. A mailbox
from before this was deployed is counted once, the first time a mail app
connects to it or mail arrives; until then it is shown as "Not counted yet".
After that the count moves with each message, so showing it costs one small
read.

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

- **Email address or name, with an app password** (HTTP Basic). The way for
  mail clients.
- **Bearer token**: an access token from the identity provider, issued for
  the mail client of this user pool.

The account's own password over HTTP Basic is refused.

Things to know:

- **A second step is each user's choice.** The account password opens only
  the sign-in pages, where a passkey can be used instead, or a code from an
  authenticator app asked for after it (see "Sign-in pages and passkeys").
- **Sizes.** A request body can be at most 5 MB and an upload 4 MB, because of
  Lambda's limits. Downloads have no such limit: large ones are redirected to
  a private, signed S3 link that is valid for five minutes.
- **Without Route53** there is no `mail.<domain>`: the API is served on the
  address API Gateway generates, shown in `api_url`.

### What is done about unwanted and forged mail

Mail on its way in is checked by SES, and filed by what the checks came to:

| What SES found                                            | What happens                                                |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| A virus                                                   | Discarded.                                                  |
| Spam                                                      | Filed in Junk, with the `$junk` keyword.                    |
| Failed DMARC, and its domain asks to quarantine or reject | Filed in Junk, with `$junk` and `$phishing`.                |
| Failed DMARC, and its domain only asks to be told         | Delivered, with `$phishing`: the webmail warns above it.    |
| No DMARC policy, and neither SPF nor DKIM passed          | Delivered, with `mailless-unverified`: the webmail says so. |
| From an address or a domain the account has blocked       | Filed in Junk, with `$junk`. The sender is not told.        |

Blocked senders are each account's own (`BlockedSender` in JMAP, under a
capability of this project's; the webmail keeps them in its settings, and
reporting a message as junk adds who sent it).

Mail on its way to the domain is kept to TLS. The receipt rule refuses
anything else, and with `route53_zone_id` set the domain says so to senders
beforehand (MTA-STS): a policy at `https://mta-sts.<domain>` that names the
inbound server, so that a sender holds mail back sooner than hand it to
another server or send it in the clear. `mta_sts_mode = "testing"` has senders
only report what they would have held back; `null` publishes nothing.

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
