// The lock Terraform holds on this stack's state while it changes it: a small
// object next to the state in S3, which a run that was cut short leaves behind.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';

/** Where this working directory keeps its state, or null before `terraform init`. */
export function initialisedBackend(infraDir) {
  try {
    const state = JSON.parse(
      readFileSync(join(infraDir, '.terraform', 'terraform.tfstate'), 'utf8'),
    );
    const { bucket, key, region } = state?.backend?.config ?? {};
    return bucket && key && region ? { bucket, key, region } : null;
  } catch {
    return null;
  }
}

export function lockKey(stateKey) {
  return `${stateKey}.tflock`;
}

/** The lock as Terraform wrote it, or null when the state is not locked. */
export async function readLock(s3, { bucket, key }) {
  let body;
  try {
    const found = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: lockKey(key) }),
    );
    body = await found.Body.transformToString();
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404)
      return null;
    throw error;
  }
  let lock;
  try {
    lock = JSON.parse(body);
  } catch {
    lock = null;
  }
  if (typeof lock?.ID !== 'string' || lock.ID === '') {
    throw new Error(
      `s3://${bucket}/${lockKey(key)} is there but is not a lock Terraform wrote. ` +
        'Look at it before removing it.',
    );
  }
  return lock;
}

/** How long ago something was, in words. */
export function ago(created, now = new Date()) {
  const minutes = Math.round((now - new Date(created)) / 60000);
  if (!Number.isFinite(minutes)) return 'at an unknown time';
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Who holds the lock, since when and for what, to read before removing it. */
export function describeLock(lock, now = new Date()) {
  return [
    `  held by   ${lock.Who || 'someone unknown'}`,
    `  since     ${lock.Created || 'unknown'} (${ago(lock.Created, now)})`,
    `  for       ${lock.Operation || 'an unknown operation'}`,
    `  lock id   ${lock.ID}`,
  ].join('\n');
}
