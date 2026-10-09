import {
  DeleteObjectCommand,
  DeleteObjectTaggingCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  BlobStore,
  KeepGoing,
  PutBlobOptions,
} from '@mailless/jmap-engine';

/**
 * The tag a temporary blob is stored with. Nothing here removes one: a
 * lifecycle rule on the bucket that expires objects with this tag does, and
 * without such a rule they simply stay.
 */
export const TEMPORARY_TAG = { key: 'mailless-temporary', value: 'true' };

export interface S3BlobStoreOptions {
  client: S3Client;
  bucket: string;
  /** Prepended to every object key, e.g. `blobs/`. */
  keyPrefix?: string;
}

function isMissing(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return (
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NotFound' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Stores each blob as one object at `<prefix><account>/<blobId>`. Works with
 * S3 and S3-compatible servers. Encryption is left to the bucket's default
 * encryption configuration.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;

  constructor(options: S3BlobStoreOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? '';
  }

  /** The object key for a blob, for callers that write objects by other means (such as SES). */
  key(accountId: string, blobId: string): string {
    return `${this.keyPrefix}${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}`;
  }

  async put(
    accountId: string,
    blobId: string,
    data: Uint8Array,
    options: PutBlobOptions = {},
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(accountId, blobId),
        Body: data,
        ContentLength: data.length,
        ...(options.temporary
          ? { Tagging: `${TEMPORARY_TAG.key}=${TEMPORARY_TAG.value}` }
          : {}),
      }),
    );
  }

  async keep(accountId: string, blobId: string): Promise<void> {
    try {
      // Without the tag, the rule that expires temporary blobs passes it by.
      await this.client.send(
        new DeleteObjectTaggingCommand({
          Bucket: this.bucket,
          Key: this.key(accountId, blobId),
        }),
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async get(accountId: string, blobId: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key(accountId, blobId),
        }),
      );
      if (!response.Body) return new Uint8Array();
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(accountId: string, blobId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.key(accountId, blobId),
      }),
    );
  }

  /**
   * Lists the account's objects a page at a time (up to 1000) and removes
   * each page with one call. Needs to list the bucket under the account's
   * prefix, which nothing else here does.
   */
  async purge(accountId: string, keepGoing?: KeepGoing): Promise<boolean> {
    const Prefix = `${this.keyPrefix}${encodeURIComponent(accountId)}/`;
    for (;;) {
      if (keepGoing && !keepGoing()) return false;
      // Always from the start: what the last round listed is gone.
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix }),
      );
      const keys = (listed.Contents ?? []).flatMap((object) =>
        object.Key ? [{ Key: object.Key }] : [],
      );
      if (keys.length === 0) return true;
      const removed = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      const failed = removed.Errors?.length ?? 0;
      if (failed > 0) {
        // No key in the message: a key holds the account and the blob's id.
        throw new Error(
          `${failed} objects could not be removed (${removed.Errors?.[0]?.Code ?? 'unknown'})`,
        );
      }
    }
  }
}
