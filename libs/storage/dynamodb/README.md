# @mailless/storage-dynamodb

A DynamoDB `MetadataStore` for
[`@mailless/jmap-server`](../../../jmap/server). It works against DynamoDB and
against DynamoDB-compatible servers such as DynamoDB Local.

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';

const metadata = new DynamoDbMetadataStore({
  client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tableName: 'mailless-metadata',
});
```

Pair it with a blob store (`@mailless/storage-s3` or `@mailless/storage-fs`)
to form a `StorageAdapter`.

## Table

One table with string keys `pk` (partition) and `sk` (sort) and no secondary
indexes. `tableDefinition(tableName)` returns the matching `CreateTable`
input; the Terraform in [`infra/`](../../../infra) creates the same shape.

| Item        | `pk`                                 | `sk`              |
| ----------- | ------------------------------------ | ----------------- |
| Record      | `R#<account>#<type>`                 | `<id>`            |
| Index entry | `I#<account>#<type>#<index>#<value>` | `<id>`            |
| Change log  | `L#<account>#<type>`                 | `<sequence>#<id>` |
| State       | `S#<account>`                        | `<type>`          |

Every commit writes the state item of each data type it changed. A table
stream filtered on `STATE_KEY_PREFIX` therefore reports each change once, and
`parseStateKey` turns a stream record's key into `{ accountId, type }`. That
is how push notifications are driven without the writer having to wait for
them.

## Behaviour worth knowing

- **Every commit is one transaction**, so records, index entries, the change
  log and the state move together. DynamoDB allows 100 writes per
  transaction; a commit that needs more is rejected with a clear error.
- **Commits that touch the same data type in the same account are
  serialised** through that type's state item and retried internally with
  backoff. That keeps change-log order correct; it also means throughput per
  account is bounded, which suits mailboxes and not shared high-volume data.
- **All reads are strongly consistent.**
- **The change log is never trimmed.** It grows with every change.
- **Items are limited to 400 KB**, which bounds the metadata of one email
  (its headers, mostly).

## Tests

The tests need DynamoDB Local: run `docker compose up -d` at the workspace
root, then `pnpm nx test storage-dynamodb`. They are skipped when nothing is
listening, unless `REQUIRE_LOCAL_SERVICES` is set. The suite includes the
storage contract and JMAP conformance tests exported by
`@mailless/jmap-server/testing`.

Requires Node.js 22.12 or newer. Licensed under Apache-2.0.
