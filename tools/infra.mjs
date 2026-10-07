// `pnpm infra <task>` runs an Nx task of the infra project, e.g. `pnpm infra plan`.
// Nx is run directly, with this terminal attached, so Terraform can ask for confirmation.
import { spawnSync } from 'node:child_process';

const [task, ...rest] = process.argv.slice(2);
if (!task || task.startsWith('-')) {
  console.error(
    'Usage: pnpm infra <task>\n\n' +
      '  plan      show what would change\n' +
      '  apply     deploy (Terraform asks before changing anything)\n' +
      '  password  set the sign-in password of a mailbox user: pnpm infra password <name>\n' +
      '  init      create the state bucket if needed and initialise Terraform\n' +
      '  validate  check the configuration\n' +
      '  test      run the infrastructure tests\n' +
      '  lint      check formatting\n',
  );
  process.exit(1);
}

// Typing a password needs the real terminal, which Nx does not pass on to a task.
// It is not a build step either, so it runs directly.
const result =
  task === 'password'
    ? spawnSync(process.execPath, ['infra/scripts/set-password.mjs', ...rest], {
        stdio: 'inherit',
      })
    : spawnSync('nx', ['run', `infra:${task}`, ...rest], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
