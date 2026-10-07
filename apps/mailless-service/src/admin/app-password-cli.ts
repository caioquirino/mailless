import type { AppPasswordStore } from '@mailless/jmap-server/auth';

export interface AppPasswordCliOptions {
  store: AppPasswordStore;
  /** The sign-in names that exist. Guards against a typo creating a password nobody can use. */
  accounts: readonly string[];
  print(line: string): void;
}

export const APP_PASSWORD_USAGE = [
  'Usage:',
  '  pnpm infra app-password create <label> [--account <name>]',
  '  pnpm infra app-password list [--account <name>]',
  '  pnpm infra app-password revoke <id> [--account <name>]',
  '',
  'The label says where the password is used, for example "Mailtemi on phone".',
  'The account can be left out when the deployment has only one.',
].join('\n');

export class UsageError extends Error {}

function takeAccount(args: string[], accounts: readonly string[]): string {
  const flag = args.indexOf('--account');
  let account: string | undefined;
  if (flag !== -1) {
    account = args[flag + 1];
    args.splice(flag, 2);
    if (!account) throw new UsageError('--account needs a name.');
  } else if (accounts.length === 1) {
    account = accounts[0];
  }
  if (!account) {
    throw new UsageError(
      `Say which account with --account. Accounts: ${accounts.join(', ') || '(none)'}`,
    );
  }
  if (!accounts.includes(account)) {
    throw new UsageError(
      `There is no account "${account}". Accounts: ${accounts.join(', ') || '(none)'}`,
    );
  }
  return account;
}

/** Runs one `app-password` command. Throws UsageError for anything the user should correct. */
export async function runAppPasswordCommand(
  argv: readonly string[],
  { store, accounts, print }: AppPasswordCliOptions,
): Promise<void> {
  const args = [...argv];
  const command = args.shift();
  if (command !== 'create' && command !== 'list' && command !== 'revoke') {
    throw new UsageError(APP_PASSWORD_USAGE);
  }
  const account = takeAccount(args, accounts);

  if (command === 'create') {
    const label = args.join(' ').trim();
    if (!label)
      throw new UsageError(
        'Give the password a label, for example "Mailtemi on phone".',
      );
    const created = await store.create(account, label);
    print(`App password for ${account} ("${created.label}"):`);
    print('');
    print(`    ${created.secret}`);
    print('');
    print(
      'It is shown only this once. In the mail client, sign in with your email',
    );
    print('address and this password in place of your real one.');
    print(`To revoke it later: pnpm infra app-password revoke ${created.id}`);
    return;
  }

  if (command === 'list') {
    const passwords = await store.list(account);
    if (passwords.length === 0) {
      print(`${account} has no app passwords.`);
      return;
    }
    print(`App passwords of ${account}:`);
    for (const password of passwords) {
      const used = password.lastUsedAt
        ? `last used ${password.lastUsedAt}`
        : 'never used';
      print(
        `  ${password.id}  ${password.label}  (created ${password.createdAt}, ${used})`,
      );
    }
    return;
  }

  const id = args[0];
  if (!id)
    throw new UsageError(
      'Say which password to revoke, by its id from `list`.',
    );
  if (!(await store.revoke(account, id))) {
    throw new UsageError(`${account} has no app password with id "${id}".`);
  }
  print(`Revoked. Clients using it are signed out within a minute.`);
}
