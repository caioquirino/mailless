import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  cachedReader,
  InMemoryDirectory,
  readerWithFallback,
  type DirectoryConfiguration,
  type DirectoryReader,
} from '@mailless/directory';
import { DynamoDbDirectory } from '@mailless/directory-dynamodb';
import { parseMailboxMap } from './ingest/recipients.js';

function parseObject<T>(name: string, json: string | undefined): T {
  if (!json) return {} as T;
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as T;
}

/** The accounts as the environment describes them: how they were set before there was a table. */
export function configurationFromEnvironment(
  env: Record<string, string | undefined>,
): DirectoryConfiguration {
  return {
    mailboxes: parseMailboxMap(env['MAILBOXES']),
    names: parseObject('ACCOUNT_NAMES', env['ACCOUNT_NAMES']),
    shares: parseObject('ACCOUNT_SHARES', env['ACCOUNT_SHARES']),
  };
}

/** A reader over a directory that is still being made. */
function eventually(
  directory: () => Promise<DirectoryReader>,
): DirectoryReader {
  return {
    resolveAddress: async (address) =>
      (await directory()).resolveAddress(address),
    account: async (id) => (await directory()).account(id),
    addressesOf: async (id) => (await directory()).addressesOf(id),
    sharedWith: async (user) => (await directory()).sharedWith(user),
  };
}

/**
 * The directory a function reads. With `DIRECTORY_TABLE` it is the table,
 * and what the table does not have is still taken from the environment, so
 * that moving the accounts into the table leaves no moment without them.
 * `onFallback` is told each time the environment had to answer.
 */
export function directoryFromEnvironment(
  env: Record<string, string | undefined>,
  client: DynamoDBDocumentClient,
  onFallback?: (question: string) => void,
): DirectoryReader {
  let configured: Promise<DirectoryReader> | undefined;
  const fromEnvironment = eventually(
    () =>
      (configured ??= InMemoryDirectory.from(
        configurationFromEnvironment(env),
      )),
  );
  const tableName = env['DIRECTORY_TABLE'];
  if (!tableName) return fromEnvironment;
  return cachedReader(
    readerWithFallback(
      new DynamoDbDirectory({ client, tableName }),
      fromEnvironment,
      onFallback,
    ),
  );
}
