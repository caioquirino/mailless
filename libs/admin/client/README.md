# @mailless/admin-client

A typed client for the [mailless administration API](../api), generated
from its OpenAPI document. It uses `fetch` and has no dependencies, so it
runs in a browser as it is.

```ts
import { createAdminClient, getMe, addAddress } from '@mailless/admin-client';

const client = createAdminClient({
  baseUrl: 'https://mail.example.com/admin/api',
  token: () => session.accessToken,
});

const { data, error } = await getMe({ client });
if (error) console.log(error.error); // 'unauthorized', 'forbidden', ...

await addAddress({ client, path: { id: 'ann', address: 'ann@example.com' } });
```

Every operation of the API is a function of the same name as its
`operationId`, and every type the API names (`Account`, `Me`, `Passkey`, ...)
is exported. A refusal is handed back as `error`, never thrown.

## How it is made

`src/generated` is written by
[`@hey-api/openapi-ts`](https://heyapi.dev) from
`libs/admin/api/openapi.json` and is not committed:

```sh
pnpm nx run admin-client:generate
```

Building, type-checking, linting and testing this package all run that first,
so the client can never be older than the API it is built against. When the
API changes in a way a caller depends on, whatever uses this client stops
compiling.

The tests call the real API in memory through the generated client, so a
document that says one thing while the API does another is caught here.
