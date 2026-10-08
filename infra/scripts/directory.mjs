// Runs the directory command of the admin tool against this deployment:
// `pnpm infra directory show`. Needs AWS credentials.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './state-bucket.mjs';

const infraDir = dirname(dirname(fileURLToPath(import.meta.url)));
const admin = join(
  infraDir,
  '..',
  'apps',
  'mailless-service',
  'dist',
  'admin.mjs',
);

function terraformOutput(name) {
  try {
    return JSON.parse(
      execFileSync('terraform', ['output', '-json', name], {
        cwd: infraDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    throw new Error(
      `Could not read the "${name}" output. Deploy first with \`pnpm infra apply\`.`,
    );
  }
}

try {
  if (!existsSync(admin)) {
    throw new Error(
      'The admin tool is not built. Run `pnpm nx build mailless-service`.',
    );
  }
  const { region } = readSettings(join(infraDir, 'terraform.tfvars'));
  const result = spawnSync(
    process.execPath,
    [admin, 'directory', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        AWS_REGION: process.env.AWS_REGION ?? region,
        DIRECTORY_TABLE:
          process.env.DIRECTORY_TABLE ?? terraformOutput('directory_table'),
      },
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
