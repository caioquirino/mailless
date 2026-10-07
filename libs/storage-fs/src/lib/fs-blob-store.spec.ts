import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryMetadataStore } from '@mailless/jmap-server/memory';
import {
  describeJmapConformance,
  describeStorageContract,
} from '@mailless/jmap-server/testing';
import { FsBlobStore } from './fs-blob-store.js';

const directories: string[] = [];
const factory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mailless-fs-'));
  directories.push(directory);
  return {
    metadata: new InMemoryMetadataStore(),
    blobs: new FsBlobStore(directory),
  };
};

afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describeStorageContract('filesystem blobs', factory);
describeJmapConformance('filesystem blobs', factory);

describe('FsBlobStore paths', () => {
  it('keeps hostile account and blob ids inside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mailless-fs-'));
    directories.push(root);
    const store = new FsBlobStore(join(root, 'data'));
    const data = new TextEncoder().encode('x');

    await store.put('../../escape', '../../../etc/passwd', data);
    await store.put('..', '.', data);
    await store.put('a/b', 'c\\d', data);

    expect(await store.get('../../escape', '../../../etc/passwd')).toEqual(
      data,
    );
    expect(await store.get('..', '.')).toEqual(data);
    expect(await readdir(root)).toEqual(['data']);
    for (const account of await readdir(join(root, 'data'))) {
      expect(account).toMatch(/^[A-Za-z0-9_~-]+$/);
    }
  });

  it('leaves no temporary files behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mailless-fs-'));
    directories.push(root);
    const store = new FsBlobStore(root);
    await store.put('acc', 'blob', new Uint8Array([1, 2, 3]));
    await store.put('acc', 'blob', new Uint8Array([4]));
    expect(await readdir(join(root, 'acc'))).toEqual(['blob']);
    expect(await store.get('acc', 'blob')).toEqual(new Uint8Array([4]));
  });
});
