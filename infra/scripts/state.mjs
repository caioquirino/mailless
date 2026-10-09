// Looks at, and removes, the lock on this stack's Terraform state.
//   pnpm infra state show     say whether the state is locked, and by whom
//   pnpm infra state unlock   remove a lock that a run which was cut short left behind
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { describeLock, initialisedBackend, readLock } from './state-lock.mjs';

const infraDir = dirname(dirname(fileURLToPath(import.meta.url)));
const [action, ...flags] = process.argv.slice(2);
const sure = flags.includes('--yes');

try {
  if (action !== 'show' && action !== 'unlock') {
    throw new Error(
      'Usage: pnpm infra state <show|unlock> [--yes]\n\n' +
        '  show    say whether the state is locked, and by whom\n' +
        '  unlock  remove the lock, after showing it and asking (--yes does not ask)',
    );
  }
  const backend = initialisedBackend(infraDir);
  if (!backend) {
    throw new Error(
      'Terraform is not initialised here yet. Run `pnpm infra init` first.',
    );
  }
  let lock;
  try {
    lock = await readLock(new S3Client({ region: backend.region }), backend);
  } catch (error) {
    throw new Error(
      `Could not look for the lock in s3://${backend.bucket} (${error.name}): ${error.message}`,
    );
  }
  if (!lock) {
    console.log('The state is not locked.');
  } else {
    console.log(`The state is locked:\n\n${describeLock(lock)}\n`);
    if (action === 'unlock') await unlock(lock);
  }

  if (existsSync(join(infraDir, 'errored.tfstate'))) {
    console.log(
      '\ninfra/errored.tfstate is there: a run changed things and could not save the state.\n' +
        'Until it is saved, Terraform does not know about what that run made. To save it:\n\n' +
        '  (cd infra && terraform state push errored.tfstate && rm errored.tfstate)\n',
    );
  }
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

async function unlock(lock) {
  if (!sure) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'Nothing was changed: there is no terminal to ask on. Pass --yes to unlock without being asked.',
      );
    }
    console.log(
      'Remove it only if that run is over. Unlocking under a run that is still\n' +
        'going lets two runs change the state at once, which can damage it.\n',
    );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await terminal.question('Type "yes" to remove the lock: ');
    terminal.close();
    if (answer.trim() !== 'yes') {
      console.log('\nNothing was changed.');
      return;
    }
  }
  const terraform = spawnSync(
    'terraform',
    ['force-unlock', '-force', lock.ID],
    { cwd: infraDir, stdio: 'inherit' },
  );
  if (terraform.error) throw terraform.error;
  if (terraform.status !== 0) process.exit(terraform.status ?? 1);
}
