# Infrastructure

Terraform for the AWS side of mailless: receiving mail through SES, storing it
in S3 and DynamoDB, and serving it to mail clients over a JMAP API.

> **Receiving is proven; the API is new.** Inbound delivery has been confirmed
> with real mail on a real account. The JMAP API, its hostname and the Cognito
> sign-in pass `terraform validate`, a mocked-provider test suite and a real
> `plan`, but have not been exercised with a mail client yet.

## What it creates

| Resource                                       | Purpose                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| SES domain identity with DKIM                  | Proves ownership of the domain.                                                                                 |
| SES receipt rule set and rule                  | Accepts mail for the domain over TLS, scans it, stores it in S3, then invokes the ingest function.              |
| S3 bucket                                      | `inbound/` holds raw messages until imported; `blobs/` holds the mailbox content. Encrypted, private, TLS only. |
| DynamoDB table                                 | Mailbox metadata and change log. On-demand billing, point-in-time recovery, deletion protection.                |
| Ingest Lambda (`nodejs24.x`, arm64)            | Imports each message into the recipients' accounts.                                                             |
| SQS dead-letter queue                          | Catches deliveries that still fail after two retries.                                                           |
| KMS key (optional, on by default)              | Customer-managed encryption for the bucket and table.                                                           |
| Cognito user pool                              | Who may sign in: one user per account id in `mailboxes`. Sign-up is closed.                                     |
| API Lambda and HTTP API                        | The JMAP endpoints, throttled, with access logs that hold no credentials or content.                            |
| Certificate and `mail.<domain>` (with Route53) | The API's own hostname, plus an SRV record so clients can find it from an address.                              |
| Route53 records (optional)                     | MX and three DKIM CNAMEs, when the domain's zone is in Route53.                                                 |

Everything is pay-per-use except the KMS key, which costs about 1 USD a month.
Set `use_customer_kms_key = false` to use the free AWS-managed encryption.

SPF and DMARC records are not created yet. They concern sending, which is a
later milestone, and publishing them for a domain that already sends mail
elsewhere would break that mail.

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

Two ways to authenticate are accepted:

- **Username and password** (HTTP Basic). Works with any client. The client
  keeps your password, so use one you can change, and remove it from clients
  you stop using.
- **Bearer token**: a Cognito access token for this user pool.

Things to know:

- **No multi-factor authentication yet.** A password is all that protects the
  mailbox, and it cannot be combined with username-and-password sign-in.
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
The dead-letter queue (`ingest_dead_letter_queue` output) should stay empty.
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
