// Sets the sign-in password of a mailbox user: `pnpm infra password <name>`.
// The password is typed at a hidden prompt (or piped in), never passed as an
// argument, so it does not end up in shell history or the process list.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
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

/**
 * Reads a line from the terminal, showing a `*` for each character so that
 * typing and pasting are visibly received without revealing the text.
 */
function askHidden(prompt, input = process.stdin, output = process.stdout) {
  return new Promise((resolve, reject) => {
    let value = '';
    let pending = '';
    output.write(prompt);
    input.setRawMode(true);
    input.resume();

    const finish = (action) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      action();
    };

    const onData = (chunk) => {
      // Terminals may wrap a paste in these markers; they are not part of the password.
      pending += chunk.toString('utf8').replace(/\u001b\[20[01]~/g, '');
      // Wait for the rest of an escape sequence that was split across chunks.
      if (/\u001b(\[[0-9;]*)?$/.test(pending)) return;
      const text = pending.replace(/\u001b\[[0-9;]*[A-Za-z~]/g, '');
      pending = '';

      for (const character of text) {
        if (character === '\r' || character === '\n') {
          finish(() => resolve(value));
          return;
        }
        if (character === '\u0003') {
          finish(() => reject(new Error('Cancelled. Nothing was changed.')));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = [...value].slice(0, -1).join('');
            output.write('\b \b');
          }
        } else if (character === '\u0015') {
          output.write('\b \b'.repeat([...value].length));
          value = '';
        } else if (character >= ' ') {
          value += character;
          output.write('*');
        }
      }
    };
    input.on('data', onData);
  });
}

/** Reads one line when the password is piped in rather than typed. */
function readPipedLine() {
  return new Promise((resolve) => {
    const readline = createInterface({ input: process.stdin });
    let answered = false;
    readline.once('line', (line) => {
      answered = true;
      readline.close();
      resolve(line);
    });
    readline.once('close', () => {
      if (!answered) resolve('');
    });
  });
}

try {
  const username = process.argv[2];
  const users = terraformOutput('users');
  if (!username || !users.includes(username)) {
    throw new Error(
      `Usage: pnpm infra password <name>\n\nNames in this deployment: ${users.join(', ') || '(none)'}`,
    );
  }

  let password;
  if (process.stdin.isTTY) {
    password = await askHidden(`New password for ${username}: `);
    if ((await askHidden('Again: ')) !== password) {
      throw new Error('The two entries do not match. Nothing was changed.');
    }
  } else {
    password = await readPipedLine();
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
