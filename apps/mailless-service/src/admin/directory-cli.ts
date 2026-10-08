import type { Directory } from '@mailless/directory';
import { UsageError } from './app-password-cli.js';

export interface DirectoryCliOptions {
  directory: Pick<Directory, 'listAccounts' | 'addressesOf' | 'sharesOf'>;
  print(line: string): void;
}

export const DIRECTORY_USAGE = [
  'Usage:',
  '  pnpm infra directory show   list the accounts, their addresses and who they are shared with',
  '',
  'Accounts are changed in the admin interface. The first one is made with',
  '`pnpm infra admin create <account>`.',
].join('\n');

async function show({ directory, print }: DirectoryCliOptions): Promise<void> {
  const accounts = await directory.listAccounts();
  if (accounts.length === 0) {
    print(
      'There are no accounts yet. Make the first with: pnpm infra admin create <account>',
    );
    return;
  }
  for (const account of accounts) {
    const status = account.status === 'active' ? '' : `  [${account.status}]`;
    print(`${account.id}${account.name ? `  (${account.name})` : ''}${status}`);
    for (const address of await directory.addressesOf(account.id)) {
      print(`    ${address}`);
    }
    for (const [user, access] of Object.entries(
      await directory.sharesOf(account.id),
    )) {
      print(`    shared with ${user} as ${access}`);
    }
  }
}

/** Runs one `directory` command. Throws UsageError for anything the user should correct. */
export async function runDirectoryCommand(
  argv: readonly string[],
  options: DirectoryCliOptions,
): Promise<void> {
  const [command, ...rest] = argv;
  if (rest.length > 0 || command !== 'show') {
    throw new UsageError(DIRECTORY_USAGE);
  }
  await show(options);
}
