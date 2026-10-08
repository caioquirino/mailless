// Sets the sign-in password of a mailbox user: `pnpm infra password <name>`.
// The password is typed at a hidden prompt (or piped in), never passed as an
// argument, so it does not end up in shell history or the process list.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { readSecret } from './prompt.mjs';
import { readSettings } from './state-bucket.mjs';

const MINIMUM_LENGTH = 14;
const infraDir = dirname(dirname(fileURLToPath(import.meta.url)));

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
  const username = process.argv[2];
  if (!username || !/^[a-z0-9_-]{1,64}$/.test(username)) {
    throw new Error(
      'Usage: pnpm infra password <account>\n\n`pnpm infra directory show` lists the accounts.',
    );
  }

  const password = await readSecret(`New password for ${username}: `);
  if (process.stdin.isTTY && (await readSecret('Again: ')) !== password) {
    throw new Error('The two entries do not match. Nothing was changed.');
  }
  if (password.length < MINIMUM_LENGTH) {
    throw new Error(
      `The password must be at least ${MINIMUM_LENGTH} characters. Nothing was changed.`,
    );
  }

  const { region } = readSettings(join(infraDir, 'terraform.tfvars'));
  const userPoolId = terraformOutput('user_pool_id');
  console.log('Setting the password in Cognito...');
  try {
    await new CognitoIdentityProviderClient({ region }).send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: username,
        Password: password,
        Permanent: true,
      }),
      // Fail with a message instead of waiting forever if AWS cannot be reached.
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  } catch (error) {
    throw new Error(
      error.name === 'AbortError' || error.name === 'TimeoutError'
        ? 'No answer from AWS after 30 seconds. Check your network and credentials. The password may not have been changed.'
        : error.name === 'UserNotFoundException'
          ? `There is no user "${username}". \`pnpm infra directory show\` lists the accounts.`
          : `Cognito refused the change (${error.name}): ${error.message}`,
    );
  }
  console.log(`Password set for ${username}.`);
  // Leave explicitly: nothing may keep the process waiting on the terminal.
  process.exit(0);
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
