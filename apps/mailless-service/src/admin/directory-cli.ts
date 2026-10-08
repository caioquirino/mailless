import {
  DirectoryError,
  type Directory,
  type DirectoryConfiguration,
  type ShareAccess,
} from '@mailless/directory';
import { UsageError } from './app-password-cli.js';

export interface DirectoryCliOptions {
  directory: Directory;
  /** The accounts as they are configured today, to copy into the directory. */
  configuration: DirectoryConfiguration;
  print(line: string): void;
}

export const DIRECTORY_USAGE = [
  'Usage:',
  '  pnpm infra directory seed   copy the accounts in terraform.tfvars into the directory',
  '  pnpm infra directory show   list what the directory holds',
  '',
  'seed only adds: run it as often as you like. It never removes or replaces',
  'what the directory already has, and says so where the two differ.',
].join('\n');

/** What the configuration asks for, account by account. */
function wanted(configuration: DirectoryConfiguration): {
  accounts: string[];
  addresses: Array<[address: string, account: string]>;
  shares: Array<[account: string, user: string, access: ShareAccess]>;
} {
  const addresses = Object.entries(configuration.mailboxes ?? {}).map(
    ([address, account]): [string, string] => [address.toLowerCase(), account],
  );
  const shares: Array<[string, string, ShareAccess]> = [];
  for (const [account, share] of Object.entries(configuration.shares ?? {})) {
    const members = new Set(share.members ?? []);
    for (const user of new Set([...members, ...(share.readers ?? [])])) {
      // An account is its own user's already; listed as both, a user is a member.
      if (user === account) continue;
      shares.push([account, user, members.has(user) ? 'member' : 'reader']);
    }
  }
  const accounts = new Set([
    ...addresses.map(([, account]) => account),
    ...shares.flatMap(([account, user]) => [account, user]),
  ]);
  return { accounts: [...accounts].sort(), addresses, shares };
}

async function seed({
  directory,
  configuration,
  print,
}: DirectoryCliOptions): Promise<boolean> {
  const { accounts, addresses, shares } = wanted(configuration);
  const names = configuration.names ?? {};
  let added = 0;
  const differences: string[] = [];

  for (const id of accounts) {
    const existing = await directory.account(id);
    if (!existing) {
      await directory.createAccount({ id, name: names[id] ?? null });
      added += 1;
    } else if ((names[id] ?? null) !== existing.name) {
      differences.push(
        `account ${id}: named ${JSON.stringify(existing.name)} in the directory, ${JSON.stringify(names[id] ?? null)} in the configuration`,
      );
    }
  }

  for (const [address, account] of addresses) {
    if ((await directory.addressesOf(account)).includes(address)) continue;
    try {
      await directory.addAddress(account, address);
      added += 1;
    } catch (error) {
      if (!(error instanceof DirectoryError)) throw error;
      differences.push(`address ${address}: ${error.message}`);
    }
  }

  for (const [account, user, access] of shares) {
    const existing = (await directory.sharesOf(account))[user];
    if (existing === undefined) {
      await directory.setShare(account, user, access);
      added += 1;
    } else if (existing !== access) {
      differences.push(
        `share of ${account} with ${user}: ${existing} in the directory, ${access} in the configuration`,
      );
    }
  }

  // The check that matters: does mail for every configured address go where it went before?
  let delivered = 0;
  for (const [address, account] of addresses) {
    const probe = address.startsWith('*@')
      ? `mailless-seed-check${address.slice(1)}`
      : address;
    const found = await directory.resolveAddress(probe);
    // A whole domain may rightly be answered by an exact address of the same account.
    if (found === account) delivered += 1;
    else {
      differences.push(
        `address ${address}: delivers to ${found ?? 'nobody'} in the directory, to ${account} in the configuration`,
      );
    }
  }

  print(
    `Added ${added} ${added === 1 ? 'entry' : 'entries'}. ` +
      `${accounts.length} accounts, ${addresses.length} addresses and ${shares.length} shares are configured.`,
  );
  print(
    `${delivered} of ${addresses.length} configured addresses deliver to the same account in the directory.`,
  );
  const unique = [...new Set(differences)];
  if (unique.length === 0) {
    print('The directory matches the configuration.');
    return true;
  }
  print('');
  print('Left as it is, because the directory already says otherwise:');
  for (const difference of unique) print(`  ${difference}`);
  return false;
}

async function show({ directory, print }: DirectoryCliOptions): Promise<void> {
  const accounts = await directory.listAccounts();
  if (accounts.length === 0) {
    print('The directory is empty. Fill it with: pnpm infra directory seed');
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

/**
 * Runs one `directory` command. Returns false when the directory was left
 * differing from the configuration, which a caller should report as a failure.
 */
export async function runDirectoryCommand(
  argv: readonly string[],
  options: DirectoryCliOptions,
): Promise<boolean> {
  const [command, ...rest] = argv;
  if (rest.length > 0 || (command !== 'seed' && command !== 'show')) {
    throw new UsageError(DIRECTORY_USAGE);
  }
  if (command === 'seed') return seed(options);
  await show(options);
  return true;
}
