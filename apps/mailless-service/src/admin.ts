// Command-line administration, run with AWS credentials: `pnpm infra app-password ...`
// `pnpm infra directory ...` and `pnpm infra admin ...`.
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbDirectory } from '@mailless/directory-dynamodb';
import { CognitoIdentityProvider } from '@mailless/identity-cognito';
import { createAppPasswordStore } from '@mailless/app-passwords';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import {
  ADMIN_ROLE_USAGE,
  runAdminRoleCommand,
} from './admin/admin-role-cli.js';
import {
  APP_PASSWORD_USAGE,
  runAppPasswordCommand,
  UsageError,
} from './admin/app-password-cli.js';
import { DIRECTORY_USAGE, runDirectoryCommand } from './admin/directory-cli.js';
import { configurationFromEnvironment } from './directory.js';

const [topic, ...rest] = process.argv.slice(2);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

try {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const print = (line: string) => console.log(line);
  if (topic === 'app-password') {
    await runAppPasswordCommand(rest, {
      store: createAppPasswordStore(
        new DynamoDbMetadataStore({
          client,
          tableName: required('TABLE_NAME'),
        }),
      ),
      accounts: JSON.parse(process.env['ACCOUNTS'] ?? '[]') as string[],
      print,
    });
  } else if (topic === 'directory') {
    const matches = await runDirectoryCommand(rest, {
      directory: new DynamoDbDirectory({
        client,
        tableName: required('DIRECTORY_TABLE'),
      }),
      configuration: configurationFromEnvironment(process.env),
      print,
    });
    if (!matches) process.exitCode = 1;
  } else if (topic === 'admin') {
    await runAdminRoleCommand(rest, {
      identity: new CognitoIdentityProvider({
        client: new CognitoIdentityProviderClient({}),
        userPoolId: required('USER_POOL_ID'),
      }),
      role: process.env['ADMIN_ROLE'] || 'MAILLESS_ADMIN',
      print,
    });
  } else {
    throw new UsageError(
      [APP_PASSWORD_USAGE, DIRECTORY_USAGE, ADMIN_ROLE_USAGE].join('\n\n'),
    );
  }
} catch (error) {
  console.error(
    `\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(error instanceof UsageError ? 2 : 1);
}
