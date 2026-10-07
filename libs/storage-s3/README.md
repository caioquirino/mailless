# @mailless/storage-s3

An S3 `BlobStore` for [`@mailless/jmap-server`](../jmap-server). It works with
S3 and S3-compatible servers.

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { S3BlobStore } from '@mailless/storage-s3';

const blobs = new S3BlobStore({
  client: new S3Client({}),
  bucket: 'my-mail-bucket',
  keyPrefix: 'blobs/',
});
```

Each blob is one object at `<keyPrefix><account>/<blobId>`, with both parts
URL-encoded. The store does not set encryption itself; configure default
encryption on the bucket.

## Tests

The tests need an S3-compatible server: run `docker compose up -d` at the
workspace root, then `pnpm nx test storage-s3`. They are skipped when nothing
is listening, unless `REQUIRE_LOCAL_SERVICES` is set.

Requires Node.js 22.12 or newer. Licensed under Apache-2.0.
