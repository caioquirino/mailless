import { IdentityError, type IdentityProvider } from '@mailless/identity';
import { UsageError } from './app-password-cli.js';

export interface AdminRoleCliOptions {
  identity: IdentityProvider;
  /** The role that lets a user administer the deployment. */
  role: string;
  print(line: string): void;
}

export const ADMIN_ROLE_USAGE = [
  'Usage:',
  '  pnpm infra admin grant <account>    let a user administer this deployment',
  '  pnpm infra admin revoke <account>   take that away again',
  '  pnpm infra admin list               say who may',
  '',
  'The first administrator is made here. After that, administrators can make',
  'others in the admin interface.',
].join('\n');

/** Runs one `admin` command. Throws UsageError for anything the user should correct. */
export async function runAdminRoleCommand(
  argv: readonly string[],
  { identity, role, print }: AdminRoleCliOptions,
): Promise<void> {
  const [command, account, ...rest] = argv;
  if (command === 'list' && account === undefined) {
    const admins = (await identity.listUsers()).filter((user) =>
      user.roles.includes(role),
    );
    if (admins.length === 0) {
      print('Nobody may administer this deployment yet.');
      print(
        'Make the first administrator with: pnpm infra admin grant <account>',
      );
      return;
    }
    print('May administer this deployment:');
    for (const admin of admins) {
      print(`  ${admin.username}${admin.enabled ? '' : '  [disabled]'}`);
    }
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
