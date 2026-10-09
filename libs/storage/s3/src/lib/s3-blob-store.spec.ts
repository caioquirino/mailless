import {
  CreateBucketCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { InMemoryMetadataStore } from '@mailless/jmap-server/memory';
import {
  describeJmapConformance,
  describeStorageContract,
} from '@mailless/jmap-server/testing';
import { S3BlobStore, TEMPORARY_TAG } from './s3-blob-store.js';

// Needs an S3-compatible server: `docker compose up -d` at the workspace root.
const endpoint = process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9090';
const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const bucket = `mailless-test-${Date.now().toString(36)}`;
let reachable = true;
try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
} catch (error) {
  reachable = false;
  if (process.env['REQUIRE_LOCAL_SERVICES']) throw error;
  console.warn(`Skipping S3 tests: nothing reachable at ${endpoint}`);
}

let run = 0;
const factory = () => ({
  metadata: new InMemoryMetadataStore(),
  blobs: new S3BlobStore({ client, bucket, keyPrefix: `run-${run++}/` }),
});

describe.skipIf(!reachable)('S3BlobStore', () => {
  describeStorageContract('S3 blobs', factory);
  describeJmapConformance('S3 blobs', factory);

  it('writes objects under the prefix, account and blob id', async () => {
    const store = new S3BlobStore({ client, bucket, keyPrefix: 'layout/' });
    await store.put('acc/../x', 'blob id', new Uint8Array([1]));
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'layout/' }),
    );
    expect(listed.Contents?.map((object) => object.Key)).toEqual([
      'layout/acc%2F..%2Fx/blob%20id',
    ]);
    expect(store.key('acc/../x', 'blob id')).toBe(
      'layout/acc%2F..%2Fx/blob%20id',
    );
  });

  it('tags a temporary blob for the bucket to expire, until it is kept', async () => {
    const store = new S3BlobStore({ client, bucket, keyPrefix: 'tags/' });
    const tags = async (blobId: string) =>
      (
        await client.send(
          new GetObjectTaggingCommand({
            Bucket: bucket,
            Key: store.key('a', blobId),
          }),
        )
      ).TagSet;
    await store.put('a', 'stays', new Uint8Array([1]));
    await store.put('a', 'upload', new Uint8Array([2]), { temporary: true });
    expect(await tags('stays')).toEqual([]);
    expect(await tags('upload')).toEqual([
      { Key: TEMPORARY_TAG.key, Value: TEMPORARY_TAG.value },
    ]);

    await store.keep('a', 'upload');
    expect(await tags('upload')).toEqual([]);
    expect(await store.get('a', 'upload')).toEqual(new Uint8Array([2]));
  });
});
