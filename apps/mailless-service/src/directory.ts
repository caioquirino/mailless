import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { cachedReader, type DirectoryReader } from '@mailless/directory';
import { DynamoDbDirectory } from '@mailless/directory-dynamodb';

/**
 * The directory a function reads: the table named by `DIRECTORY_TABLE`.
 * Answers are remembered for a minute, so a change made in the admin
 * interface takes that long to reach every function.
 */
export function directoryFromEnvironment(
  env: Record<string, string | undefined>,
  client: DynamoDBDocumentClient,
): DirectoryReader {
  const tableName = env['DIRECTORY_TABLE'];
  if (!tableName) {
    throw new Error('Missing environment variable DIRECTORY_TABLE');
  }
  return cachedReader(new DynamoDbDirectory({ client, tableName }));
}
