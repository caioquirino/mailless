# @mailless/directory

Who has a mailbox: the accounts, the addresses that deliver to each, and which
accounts are shared with whom. It knows nothing of mail, of JMAP or of how
people sign in, and has no dependencies.

```ts
import { InMemoryDirectory, cachedReader } from '@mailless/directory';

const directory = await InMemoryDirectory.from({
  mailboxes: { 'ann@example.com': 'ann', '*@example.com': 'team' },
  names: { ann: 'Ann A' },
  shares: { team: { members: ['ann'] } },
});

await directory.resolveAddress('Ann@Example.com'); // 'ann'
await directory.resolveAddress('anyone@example.com'); // 'team'
await directory.sharedWith('ann'); // { team: 'member' }
```

## What it holds

- **Accounts**, by an id that never changes. An id is 1 to 64 small letters,
  digits, `-` or `_`: identity providers differ on whether capitals matter in
  a username, so two accounts are never told apart by them. An account is
  `active`, `disabled` (kept, but nobody signs in) or `deleting`.
- **Addresses**, each delivering to one account. `*@example.com` stands for a
  whole domain, and an exact address wins over it.
- **Shares**: other users who may use an account, as `member` (may change it)
  or `reader`.

`DirectoryReader` is the part the services that handle mail need;
`Directory` adds the changes. A change the directory refuses throws a
`DirectoryError` whose `code` is `exists`, `notFound`, `addressTaken` or
`invalid`.

## Implementations

| Directory                                               | Kept in                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `InMemoryDirectory`                                     | Memory. The reference, and what a host uses when its accounts come from configuration. |
| [`@mailless/directory-dynamodb`](../directory-dynamodb) | A DynamoDB table.                                                                      |

`describeDirectoryContract` from `@mailless/directory/testing` is the test
suite every implementation passes; run it against your own.

## Readers

- `cachedReader(reader, { ttlMs })` remembers answers for a short while (a
  minute unless told otherwise), so a change shows up within that time.
  Failures are never remembered.
- `readerWithFallback(primary, fallback, onFallback)` asks a second directory
  about accounts the first does not have. It is for moving from one directory
  to another without a moment at which mail has nowhere to go.
