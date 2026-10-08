import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  StateMismatchError,
  type StorageAdapter,
} from '../storage.js';

export type StorageAdapterFactory = () =>
  StorageAdapter | Promise<StorageAdapter>;

const ACCOUNT = 'contract-account';
const OTHER_ACCOUNT = 'contract-other';
const encoder = new TextEncoder();

/**
 * Contract tests for a StorageAdapter. Run them from a spec file in the
 * adapter's own package; `factory` must return an empty adapter each time.
 */
export function describeStorageContract(
  name: string,
  factory: StorageAdapterFactory,
): void {
  describe(`${name}: MetadataStore contract`, () => {
    let adapter: StorageAdapter;
    beforeEach(async () => {
      adapter = await factory();
    });
    const store = () => adapter.metadata;

    it('starts empty with a stable initial state', async () => {
      const state = await store().getState(ACCOUNT, 'Note');
      expect(typeof state).toBe('string');
      expect(await store().getState(ACCOUNT, 'Note')).toBe(state);
      expect(await store().get(ACCOUNT, 'Note', ['a'])).toEqual([]);
      expect(await store().list(ACCOUNT, 'Note')).toEqual([]);
      expect(await store().getChanges(ACCOUNT, 'Note', state)).toEqual([]);
    });

    it('creates records at version 1 and reads them back', async () => {
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: { text: 'one' } },
        { kind: 'create', type: 'Note', id: 'b', value: { text: 'two' } },
      ]);
      const records = await store().get(ACCOUNT, 'Note', ['b', 'a', 'missing']);
      expect(records).toHaveLength(2);
      expect(records.find((record) => record.id === 'a')).toEqual({
        id: 'a',
        version: 1,
        value: { text: 'one' },
      });
      expect(
        (await store().list(ACCOUNT, 'Note')).map((r) => r.id).sort(),
      ).toEqual(['a', 'b']);
    });

    it('keeps data types and accounts apart', async () => {
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: { text: 'one' } },
      ]);
      expect(await store().get(ACCOUNT, 'Other', ['a'])).toEqual([]);
      expect(await store().get(OTHER_ACCOUNT, 'Note', ['a'])).toEqual([]);
      expect(await store().list(OTHER_ACCOUNT, 'Note')).toEqual([]);
      expect(await store().getState(OTHER_ACCOUNT, 'Note')).toBe(
        await store().getState(ACCOUNT, 'Other'),
      );
    });

    it('does not let callers mutate stored values', async () => {
      const value = { tags: ['x'] };
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value },
      ]);
      value.tags.push('y');
      const [first] = await store().get(ACCOUNT, 'Note', ['a']);
      (first?.value['tags'] as string[]).push('z');
      const [second] = await store().get(ACCOUNT, 'Note', ['a']);
      expect(second?.value).toEqual({ tags: ['x'] });
    });

    it('rejects creating a record that exists', async () => {
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: { text: 'one' } },
      ]);
      await expect(
        store().commit(ACCOUNT, [
          { kind: 'create', type: 'Note', id: 'a', value: { text: 'again' } },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('updates with a version check', async () => {
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: { text: 'one' } },
      ]);
      await store().commit(ACCOUNT, [
        {
          kind: 'update',
          type: 'Note',
          id: 'a',
          value: { text: 'two' },
          expectedVersion: 1,
        },
      ]);
      expect(await store().get(ACCOUNT, 'Note', ['a'])).toEqual([
        { id: 'a', version: 2, value: { text: 'two' } },
      ]);

      await expect(
        store().commit(ACCOUNT, [
          {
            kind: 'update',
            type: 'Note',
            id: 'a',
            value: { text: 'stale' },
            expectedVersion: 1,
          },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);
      expect((await store().get(ACCOUNT, 'Note', ['a']))[0]?.value).toEqual({
        text: 'two',
      });
    });

    it('rejects updating or destroying a missing record', async () => {
      await expect(
        store().commit(ACCOUNT, [
          {
            kind: 'update',
            type: 'Note',
            id: 'nope',
            value: {},
            expectedVersion: 1,
          },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        store().commit(ACCOUNT, [
          { kind: 'destroy', type: 'Note', id: 'nope' },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('destroys records, optionally checking the version', async () => {
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: {} },
        { kind: 'create', type: 'Note', id: 'b', value: {} },
      ]);
      await expect(
        store().commit(ACCOUNT, [
          { kind: 'destroy', type: 'Note', id: 'a', expectedVersion: 7 },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);
      await store().commit(ACCOUNT, [
        { kind: 'destroy', type: 'Note', id: 'a', expectedVersion: 1 },
        { kind: 'destroy', type: 'Note', id: 'b' },
      ]);
      expect(await store().list(ACCOUNT, 'Note')).toEqual([]);
    });

    it('increments numeric properties without a version check', async () => {
      await store().commit(ACCOUNT, [
        {
          kind: 'create',
          type: 'Note',
          id: 'a',
          value: { text: 'one', views: 2 },
          indexes: { folder: ['inbox'] },
        },
      ]);
      const before = await store().getState(ACCOUNT, 'Note');

      await Promise.all(
        Array.from({ length: 5 }, () =>
          store().commit(ACCOUNT, [
            {
              kind: 'increment',
              type: 'Note',
              id: 'a',
              deltas: { views: 3, likes: -1 },
            },
          ]),
        ),
      );

      const [record] = await store().get(ACCOUNT, 'Note', ['a']);
      expect(record?.value).toEqual({ text: 'one', views: 17, likes: -5 });
      expect(record?.version).toBe(6);
      expect(
        await store().list(ACCOUNT, 'Note', { name: 'folder', value: 'inbox' }),
      ).toHaveLength(1);

      const entries = await store().getChanges(ACCOUNT, 'Note', before);
      expect(entries).toHaveLength(5);
      expect(entries?.[0]?.kind).toBe('updated');
      expect([...(entries?.[0]?.changedProperties ?? [])].sort()).toEqual([
        'likes',
        'views',
      ]);

      await expect(
        store().commit(ACCOUNT, [
          { kind: 'increment', type: 'Note', id: 'nope', deltas: { views: 1 } },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('applies a batch entirely or not at all', async () => {
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: { text: 'one' } },
      ]);
      const stateBefore = await store().getState(ACCOUNT, 'Note');

      await expect(
        store().commit(ACCOUNT, [
          { kind: 'create', type: 'Note', id: 'b', value: {} },
          { kind: 'create', type: 'Tag', id: 't', value: {} },
          {
            kind: 'update',
            type: 'Note',
            id: 'a',
            value: { text: 'never' },
            expectedVersion: 99,
          },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(await store().get(ACCOUNT, 'Note', ['b'])).toEqual([]);
      expect(await store().get(ACCOUNT, 'Tag', ['t'])).toEqual([]);
      expect(await store().getState(ACCOUNT, 'Note')).toBe(stateBefore);
      expect(await store().getChanges(ACCOUNT, 'Note', stateBefore)).toEqual(
        [],
      );
    });

    it('lists by index and keeps indexes in step with writes', async () => {
      await store().commit(ACCOUNT, [
        {
          kind: 'create',
          type: 'Note',
          id: 'a',
          value: {},
          indexes: { folder: ['inbox', 'work'], owner: ['me'] },
        },
        {
          kind: 'create',
          type: 'Note',
          id: 'b',
          value: {},
          indexes: { folder: ['inbox'] },
        },
        { kind: 'create', type: 'Note', id: 'c', value: {} },
      ]);
      const ids = async (name: string, value: string) =>
        (await store().list(ACCOUNT, 'Note', { name, value }))
          .map((record) => record.id)
          .sort();

      expect(await ids('folder', 'inbox')).toEqual(['a', 'b']);
      expect(await ids('folder', 'work')).toEqual(['a']);
      expect(await ids('owner', 'inbox')).toEqual([]);
      expect(await ids('folder', 'none')).toEqual([]);

      await store().commit(ACCOUNT, [
        {
          kind: 'update',
          type: 'Note',
          id: 'a',
          value: {},
          expectedVersion: 1,
          indexes: { folder: ['archive'] },
        },
        { kind: 'destroy', type: 'Note', id: 'b' },
      ]);
      expect(await ids('folder', 'inbox')).toEqual([]);
      expect(await ids('folder', 'work')).toEqual([]);
      expect(await ids('folder', 'archive')).toEqual(['a']);
      expect(await ids('owner', 'me')).toEqual([]);
    });

    it('advances the state of exactly the data types a commit touches', async () => {
      const noteBefore = await store().getState(ACCOUNT, 'Note');
      const tagBefore = await store().getState(ACCOUNT, 'Tag');
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: {} },
      ]);
      expect(await store().getState(ACCOUNT, 'Note')).not.toBe(noteBefore);
      expect(await store().getState(ACCOUNT, 'Tag')).toBe(tagBefore);
    });

    it('checks expected states atomically with the write', async () => {
      const initial = await store().getState(ACCOUNT, 'Note');
      await store().commit(
        ACCOUNT,
        [{ kind: 'create', type: 'Note', id: 'a', value: {} }],
        { expectedStates: { Note: initial } },
      );
      await expect(
        store().commit(
          ACCOUNT,
          [{ kind: 'create', type: 'Note', id: 'b', value: {} }],
          { expectedStates: { Note: initial } },
        ),
      ).rejects.toBeInstanceOf(StateMismatchError);
      expect(await store().get(ACCOUNT, 'Note', ['b'])).toEqual([]);
    });

    it('records every change in order', async () => {
      const s0 = await store().getState(ACCOUNT, 'Note');
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: {} },
        { kind: 'create', type: 'Tag', id: 't', value: {} },
      ]);
      const s1 = await store().getState(ACCOUNT, 'Note');
      await store().commit(ACCOUNT, [
        {
          kind: 'update',
          type: 'Note',
          id: 'a',
          value: { text: 'x' },
          expectedVersion: 1,
          changedProperties: ['text'],
        },
      ]);
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Tag', id: 'u', value: {} },
      ]);
      await store().commit(ACCOUNT, [
        { kind: 'destroy', type: 'Note', id: 'a' },
      ]);
      const s3 = await store().getState(ACCOUNT, 'Note');

      const all = await store().getChanges(ACCOUNT, 'Note', s0);
      expect(all?.map((entry) => [entry.id, entry.kind])).toEqual([
        ['a', 'created'],
        ['a', 'updated'],
        ['a', 'destroyed'],
      ]);
      expect(all?.[0]?.state).toBe(s1);
      expect(all?.[1]?.changedProperties).toEqual(['text']);
      expect(all?.[2]?.state).toBe(s3);
      expect(new Set(all?.map((entry) => entry.state)).size).toBe(3);

      const later = await store().getChanges(ACCOUNT, 'Note', s1);
      expect(later?.map((entry) => entry.kind)).toEqual([
        'updated',
        'destroyed',
      ]);
      expect(await store().getChanges(ACCOUNT, 'Note', s3)).toEqual([]);
    });

    it('gives every entry of one commit the same state', async () => {
      const s0 = await store().getState(ACCOUNT, 'Note');
      await store().commit(ACCOUNT, [
        { kind: 'create', type: 'Note', id: 'a', value: {} },
        { kind: 'create', type: 'Note', id: 'b', value: {} },
      ]);
      const entries = await store().getChanges(ACCOUNT, 'Note', s0);
      expect(entries).toHaveLength(2);
      expect(entries?.[0]?.state).toBe(entries?.[1]?.state);
    });

    it('returns null for a state it does not recognise', async () => {
      expect(
        await store().getChanges(ACCOUNT, 'Note', 'not-a-real-state'),
      ).toBeNull();
    });
  });

  describe(`${name}: BlobStore contract`, () => {
    let adapter: StorageAdapter;
    beforeEach(async () => {
      adapter = await factory();
    });

    it('stores, returns and deletes blobs', async () => {
      const data = encoder.encode('hello blob');
      await adapter.blobs.put(ACCOUNT, 'b1', data);
      expect(await adapter.blobs.get(ACCOUNT, 'b1')).toEqual(data);
      await adapter.blobs.delete(ACCOUNT, 'b1');
      expect(await adapter.blobs.get(ACCOUNT, 'b1')).toBeNull();
    });

    it('preserves arbitrary bytes, including an empty blob', async () => {
      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      await adapter.blobs.put(ACCOUNT, 'bin', bytes);
      await adapter.blobs.put(ACCOUNT, 'empty', new Uint8Array());
      expect(await adapter.blobs.get(ACCOUNT, 'bin')).toEqual(bytes);
      expect(await adapter.blobs.get(ACCOUNT, 'empty')).toEqual(
        new Uint8Array(),
      );
    });

    it('returns null for unknown blobs and ignores deleting them', async () => {
      expect(await adapter.blobs.get(ACCOUNT, 'missing')).toBeNull();
      await expect(
        adapter.blobs.delete(ACCOUNT, 'missing'),
      ).resolves.toBeUndefined();
    });

    it('keeps accounts apart', async () => {
      await adapter.blobs.put(ACCOUNT, 'b1', encoder.encode('mine'));
      expect(await adapter.blobs.get(OTHER_ACCOUNT, 'b1')).toBeNull();
    });
  });
}
