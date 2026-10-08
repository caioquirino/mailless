import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobStore } from '@mailless/jmap-engine';

const SAFE_NAME = /^[A-Za-z0-9_-]{1,200}$/;

/** Maps an arbitrary string to a file name that cannot escape its directory. */
function toFileName(value: string): string {
  if (SAFE_NAME.test(value)) return value;
  return `~${Buffer.from(value, 'utf8').toString('base64url')}`;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Stores each blob as one file under `<root>/<account>/<blobId>`. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(accountId: string, blobId: string): string {
    return join(this.root, toFileName(accountId), toFileName(blobId));
  }

  async put(
    accountId: string,
    blobId: string,
    data: Uint8Array,
  ): Promise<void> {
    const target = this.path(accountId, blobId);
    await mkdir(join(this.root, toFileName(accountId)), { recursive: true });
    // Write to a temporary file first so a reader never sees a half-written blob.
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, target);
  }

  async get(accountId: string, blobId: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(accountId, blobId)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(accountId: string, blobId: string): Promise<void> {
    await rm(this.path(accountId, blobId), { force: true });
  }
}
