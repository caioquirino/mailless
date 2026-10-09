// `pnpm infra <task>` runs an Nx task of the infra project, e.g. `pnpm infra plan`.
// Nx is run directly, with this terminal attached, so Terraform can ask for confirmation.
import { spawnSync } from 'node:child_process';

const [task, ...rest] = process.argv.slice(2);
if (!task || task.startsWith('-')) {
  console.error(
    'Usage: pnpm infra <task>\n\n' +
      '  plan      show what would change\n' +
      '  apply     deploy (Terraform asks before changing anything)\n' +
      '  password  set the sign-in password of a user: pnpm infra password <account>\n' +
      '  app-password  create, list or revoke per-client passwords\n' +
      '  admin     make the first account, and say who may administer: pnpm infra admin <create|grant|revoke|list>\n' +
      '  directory list the accounts and their addresses: pnpm infra directory show\n' +
      '  send-test send a test message and wait for it to arrive: pnpm infra send-test [recipient]\n' +
      '  state     see or remove the lock on the Terraform state: pnpm infra state <show|unlock>\n' +
      '  init      create the state bucket if needed and initialise Terraform\n' +
      '  validate  check the configuration\n' +
      '  test      run the infrastructure tests\n' +
      '  lint      check formatting\n',
  );
  process.exit(1);
}

// These need the real terminal to ask for a password, which Nx does not pass on to a task.
// They are not build steps either, so they run directly.
const direct = {
  password: { script: 'infra/scripts/set-password.mjs' },
  'send-test': { script: 'infra/scripts/send-test.mjs' },
  state: { script: 'infra/scripts/state.mjs' },
  // Uses the admin tool from the service build, so that is brought up to date first.
  'app-password': {
    script: 'infra/scripts/app-password.mjs',
    build: 'mailless-service',
  },
  directory: {
    script: 'infra/scripts/directory.mjs',
    build: 'mailless-service',
  },
  admin: {
    script: 'infra/scripts/admin-role.mjs',
    build: 'mailless-service',
  },
};

const entry = direct[task];
if (entry?.build) {
  const built = spawnSync('nx', ['run', `${entry.build}:build`], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (built.status !== 0) {
    console.error(
      `\nBuilding ${entry.build} failed. Run \`pnpm nx build ${entry.build}\` to see why.\n`,
    );
    process.exit(built.status ?? 1);
  }
}
const result = entry
  ? spawnSync(process.execPath, [entry.script, ...rest], { stdio: 'inherit' })
  : spawnSync('nx', ['run', `infra:${task}`, ...rest], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
