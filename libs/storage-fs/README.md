# @mailless/storage-fs

A filesystem `BlobStore` for [`@mailless/jmap-server`](../jmap-server), for
self-hosting and local development.

```ts
import { FsBlobStore } from '@mailless/storage-fs';

const blobs = new FsBlobStore('/var/lib/mailless/blobs');
```

Each blob is one file at `<root>/<account>/<blobId>`, created with mode
`0600`. Account and blob ids that are not plain file names are encoded, so no
id can reach outside the root directory. Writes go to a temporary file and are
renamed into place, so a reader never sees a partial blob.

Files are stored as given: use an encrypted volume if the content must be
encrypted at rest.

Requires Node.js 22.12 or newer. Licensed under Apache-2.0.
