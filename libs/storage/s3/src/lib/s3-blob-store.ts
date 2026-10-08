import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { BlobStore } from '@mailless/jmap-engine';

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
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(accountId, blobId),
        Body: data,
        ContentLength: data.length,
      }),
    );
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
}
