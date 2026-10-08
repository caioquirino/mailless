import { DirectoryError, type Directory } from '@mailless/directory';
import { IdentityError, type IdentityProvider } from '@mailless/identity';
import { UsageError } from './app-password-cli.js';

export interface AdminRoleCliOptions {
  identity: IdentityProvider;
  /** Who has a mailbox: where the first account is made. */
  directory: Pick<Directory, 'account' | 'createAccount'>;
  /** The role that lets a user administer the deployment. */
  role: string;
  print(line: string): void;
}

export const ADMIN_ROLE_USAGE = [
  'Usage:',
  '  pnpm infra admin create <account>   make an account whose user may administer this deployment',
  '  pnpm infra admin grant <account>    let a user administer this deployment',
  '  pnpm infra admin revoke <account>   take that away again',
  '  pnpm infra admin list               say who may',
  '',
  'The first account and administrator are made here, with create. After that,',
  'accounts and administrators are made in the admin interface.',
].join('\n');

/** Runs one `admin` command. Throws UsageError for anything the user should correct. */
export async function runAdminRoleCommand(
  argv: readonly string[],
  { identity, directory, role, print }: AdminRoleCliOptions,
): Promise<void> {
  const [command, account, ...rest] = argv;
  if (command === 'list' && account === undefined) {
    const admins = (await identity.listUsers()).filter((user) =>
      user.roles.includes(role),
    );
    if (admins.length === 0) {
      print('Nobody may administer this deployment yet.');
      print(
        'Make the first administrator with: pnpm infra admin create <account>',
      );
      return;
    }
    print('May administer this deployment:');
    for (const admin of admins) {
      print(`  ${admin.username}${admin.enabled ? '' : '  [disabled]'}`);
    }
    return;
  }
  if (command === 'create' && account && rest.length === 0) {
    // Each step only if it is still to do, so that running it again finishes
    // what an earlier run left half done.
    try {
      if (!(await directory.account(account))) {
        await directory.createAccount({ id: account });
      }
      if (!(await identity.getUser(account)))
        await identity.createUser(account);
      await identity.grantRole(account, role);
    } catch (error) {
      if (error instanceof DirectoryError && error.code === 'invalid') {
        throw new UsageError(error.message);
      }
      if (error instanceof IdentityError && error.code === 'notFound') {
        throw new UsageError(
          `The role "${role}" does not exist yet (run \`pnpm infra apply\`).`,
        );
      }
      throw error;
    }
    print(`${account} has an account and may administer this deployment.`);
    print('');
    print('Next:');
    print(`  pnpm infra password ${account}   give them a password`);
    print('  then sign in to the admin interface (terraform output admin_url)');
    print('  and add the addresses that deliver to the account.');
    return;
  }
  if (
    (command !== 'grant' && command !== 'revoke') ||
    !account ||
    rest.length > 0
  ) {
    throw new UsageError(ADMIN_ROLE_USAGE);
  }
  try {
    if (command === 'grant') {
      await identity.grantRole(account, role);
      print(`${account} may now administer this deployment.`);
      print('It takes effect the next time they sign in.');
    } else {
      await identity.revokeRole(account, role);
      // The role is in tokens already issued, so those are ended too.
      await identity.signOutEverywhere(account);
      print(`${account} may no longer administer this deployment.`);
    }
  } catch (error) {
    if (error instanceof IdentityError && error.code === 'notFound') {
      throw new UsageError(
        `There is no user "${account}", or the role "${role}" does not exist yet (run \`pnpm infra apply\`).`,
      );
    }
    throw error;
  }
}
