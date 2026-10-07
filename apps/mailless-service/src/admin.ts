// Command-line administration, run with AWS credentials: `pnpm infra app-password ...`.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAppPasswordStore } from '@mailless/jmap-server/auth';
import { DynamoDbMetadataStore } from '@mailless/storage-dynamodb';
import {
  APP_PASSWORD_USAGE,
  runAppPasswordCommand,
  UsageError,
} from './admin/app-password-cli.js';

const [topic, ...rest] = process.argv.slice(2);

try {
  if (topic !== 'app-password') throw new UsageError(APP_PASSWORD_USAGE);
  const tableName = process.env['TABLE_NAME'];
  if (!tableName) throw new Error('Missing environment variable TABLE_NAME');

  await runAppPasswordCommand(rest, {
    store: createAppPasswordStore(
      new DynamoDbMetadataStore({
        client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
        tableName,
      }),
    ),
    accounts: JSON.parse(process.env['ACCOUNTS'] ?? '[]') as string[],
    print: (line) => console.log(line),
  });
} catch (error) {
  console.error(
    `\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(error instanceof UsageError ? 2 : 1);
}
