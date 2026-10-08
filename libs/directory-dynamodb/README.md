# @mailless/directory-dynamodb

A [`@mailless/directory`](../directory) kept in a DynamoDB table. It works
against DynamoDB and DynamoDB-compatible servers such as DynamoDB Local.

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbDirectory } from '@mailless/directory-dynamodb';

const directory = new DynamoDbDirectory({
  client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tableName: 'mailless-directory',
});
```

## Table

One table with string keys `pk` (partition) and `sk` (sort) and no secondary
indexes. `directoryTableDefinition(tableName)` returns the matching
`CreateTable` input; the Terraform in [`infra/`](../../infra) creates the same
shape.

| Item                  | `pk`             | `sk`              |
| --------------------- | ---------------- | ----------------- |
| Account               | `A#<account>`    | `#`               |
| Address of an account | `A#<account>`    | `ADDR#<address>`  |
| Share of an account   | `A#<account>`    | `SHARE#<user>`    |
| Address lookup        | `ADDR#<address>` | `#`               |
| Shared with a user    | `U#<user>`       | `SHARE#<account>` |

Everything about an account is one query, an address is one read, and so is
what is shared with a user. The lookup items are written in the same
transaction as the items they mirror, so the two never disagree.

A service that only reads needs `dynamodb:GetItem` and `dynamodb:Query`.
Listing every account is a scan, which only an administration tool needs.

## Tests

The tests need DynamoDB Local: `docker compose up -d` at the workspace root.
