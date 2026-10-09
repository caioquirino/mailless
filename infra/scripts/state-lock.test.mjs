import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ago,
  describeLock,
  initialisedBackend,
  lockKey,
  readLock,
} from './state-lock.mjs';

const backend = {
  bucket: 'state',
  key: 'mailless/terraform.tfstate',
  region: 'eu-west-1',
};
const lock = {
  ID: '11111111-2222-3333-4444-555555555555',
  Operation: 'OperationTypeApply',
  Who: 'someone@machine',
  Created: '2026-01-05T09:00:00Z',
};
const s3 = (answer) => ({
  sent: [],
  async send(command) {
    this.sent.push(command.input);
    return answer();
  },
});

test('the lock is kept next to the state', () => {
  assert.equal(lockKey(backend.key), 'mailless/terraform.tfstate.tflock');
});

test('reads the lock Terraform wrote', async () => {
  const client = s3(() => ({
    Body: { transformToString: async () => JSON.stringify(lock) },
  }));
  assert.deepEqual(await readLock(client, backend), lock);
  assert.deepEqual(client.sent, [
    { Bucket: 'state', Key: 'mailless/terraform.tfstate.tflock' },
  ]);
});

test('says there is no lock when there is none', async () => {
  const missing = s3(() => {
    throw Object.assign(new Error('gone'), { name: 'NoSuchKey' });
  });
  assert.equal(await readLock(missing, backend), null);
});

test('does not take something else for a lock, or hide another failure', async () => {
  const other = s3(() => ({
    Body: { transformToString: async () => 'not a lock' },
  }));
  await assert.rejects(readLock(other, backend), /not a lock Terraform wrote/);
  const denied = s3(() => {
    throw Object.assign(new Error('no'), { name: 'AccessDenied' });
  });
  await assert.rejects(readLock(denied, backend), /no/);
});

test('says who holds it, since when and for what', () => {
  const text = describeLock(lock, new Date('2026-01-05T09:25:00Z'));
  assert.match(text, /held by {3}someone@machine/);
  assert.match(text, /25 minutes ago/);
  assert.match(text, /OperationTypeApply/);
  assert.match(text, /lock id {3}11111111-/);
});

test('tells how long ago in words', () => {
  const now = new Date('2026-01-05T12:00:00Z');
  assert.equal(ago('2026-01-05T11:59:50Z', now), 'less than a minute ago');
  assert.equal(ago('2026-01-05T11:59:00Z', now), '1 minute ago');
  assert.equal(ago('2026-01-05T07:00:00Z', now), '5 hours ago');
  assert.equal(ago('2026-01-02T12:00:00Z', now), '3 days ago');
  assert.equal(ago('nonsense', now), 'at an unknown time');
});

test('knows where an initialised directory keeps its state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-lock-'));
  assert.equal(initialisedBackend(dir), null);
  mkdirSync(join(dir, '.terraform'));
  writeFileSync(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({ backend: { config: backend } }),
  );
  assert.deepEqual(initialisedBackend(dir), backend);
});
