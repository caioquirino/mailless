import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { directoryFromEnvironment } from './directory.js';

describe('directoryFromEnvironment', () => {
  it('needs to be told which table', () => {
    expect(() =>
      directoryFromEnvironment({}, {} as DynamoDBDocumentClient),
    ).toThrow(/DIRECTORY_TABLE/);
  });
});
