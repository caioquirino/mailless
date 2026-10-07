import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  ensureStateBucket,
  initialisedBucket,
  readSettings,
  stateBucketName,
} from './state-bucket.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'mailless-infra-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Records the commands sent and answers HeadBucket with the given status. */
function fakeS3(headStatus, failOn) {
  const sent = [];
  return {
    sent,
    names: () => sent.map((command) => command.constructor.name),
    async send(command) {
      const name = command.constructor.name;
      sent.push(command);
      if (name === failOn) throw new Error(`${name} failed`);
      if (name === 'HeadBucketCommand' && headStatus !== 200) {
        throw Object.assign(new Error('head'), {
          $metadata: { httpStatusCode: headStatus },
        });
      }
      return {};
    },
  };
}

const HARDENING = [
  'PutPublicAccessBlockCommand',
  'PutBucketVersioningCommand',
  'PutBucketEncryptionCommand',
  'PutBucketPolicyCommand',
  'PutBucketLifecycleConfigurationCommand',
  'PutBucketTaggingCommand',
];

test('creates a missing bucket in its region and locks it down', async () => {
  const s3 = fakeS3(404);
  assert.equal(await ensureStateBucket(s3, 'b', 'eu-west-1'), 'created');
  assert.deepEqual(s3.names(), [
    'HeadBucketCommand',
    'CreateBucketCommand',
    ...HARDENING,
  ]);

  const input = (name) =>
    s3.sent.find((command) => command.constructor.name === name).input;
  assert.deepEqual(input('CreateBucketCommand'), {
    Bucket: 'b',
    CreateBucketConfiguration: { LocationConstraint: 'eu-west-1' },
  });
  assert.deepEqual(
    Object.values(
      input('PutPublicAccessBlockCommand').PublicAccessBlockConfiguration,
    ),
    [true, true, true, true],
  );
  assert.equal(
    input('PutBucketVersioningCommand').VersioningConfiguration.Status,
    'Enabled',
  );
  assert.equal(
    input('PutBucketEncryptionCommand').ServerSideEncryptionConfiguration
      .Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm,
    'AES256',
  );
  const [statement] = JSON.parse(
    input('PutBucketPolicyCommand').Policy,
  ).Statement;
  assert.equal(statement.Effect, 'Deny');
  assert.deepEqual(statement.Resource, ['arn:aws:s3:::b', 'arn:aws:s3:::b/*']);
  assert.deepEqual(statement.Condition, {
    Bool: { 'aws:SecureTransport': 'false' },
  });
});

test('does not name the region when creating in us-east-1', async () => {
  const s3 = fakeS3(404);
  await ensureStateBucket(s3, 'b', 'us-east-1');
  assert.deepEqual(s3.sent[1].input, { Bucket: 'b' });
});

test('does not create an existing bucket but still applies the settings', async () => {
  const s3 = fakeS3(200);
  assert.equal(await ensureStateBucket(s3, 'b', 'eu-west-1'), 'exists');
  assert.deepEqual(s3.names(), ['HeadBucketCommand', ...HARDENING]);
});

test('explains a bucket that belongs to someone else', async () => {
  const s3 = fakeS3(403);
  await assert.rejects(
    ensureStateBucket(s3, 'b', 'eu-west-1'),
    /right AWS account/,
  );
  assert.deepEqual(s3.names(), ['HeadBucketCommand']);
});

test('passes other failures through without creating anything', async () => {
  const s3 = fakeS3(500);
  await assert.rejects(ensureStateBucket(s3, 'b', 'eu-west-1'), /head/);
  assert.deepEqual(s3.names(), ['HeadBucketCommand']);
});

test('fails when a setting cannot be applied', async () => {
  const s3 = fakeS3(404, 'PutBucketVersioningCommand');
  await assert.rejects(ensureStateBucket(s3, 'b', 'eu-west-1'), /Versioning/);
});

test('names the bucket after the project, account and region', () => {
  assert.equal(
    stateBucketName({
      name: 'mailless',
      accountId: '123456789012',
      region: 'eu-west-1',
    }),
    'mailless-terraform-state-123456789012-eu-west-1',
  );
});

test('reads region and name from a tfvars file', () => {
  const file = join(scratch, 'a.tfvars');
  writeFileSync(
    file,
    '# region = "wrong"\nregion    = "eu-west-1" # comment\ndomain = "example.com"\nmailboxes = {\n  "me@example.com" = "me"\n}\n',
  );
  assert.deepEqual(readSettings(file), {
    region: 'eu-west-1',
    name: 'mailless',
    domain: 'example.com',
  });

  writeFileSync(file, 'name = "inbox"\nregion = "us-east-1"\n');
  assert.deepEqual(readSettings(file), {
    region: 'us-east-1',
    name: 'inbox',
    domain: undefined,
  });
});

test('explains a missing or incomplete tfvars file', () => {
  assert.throws(
    () => readSettings(join(scratch, 'none.tfvars')),
    /terraform.tfvars.example/,
  );
  const file = join(scratch, 'b.tfvars');
  writeFileSync(file, 'domain = "example.com"\n');
  assert.throws(() => readSettings(file), /must set region/);
});

test('reports the bucket a working directory was initialised against', () => {
  assert.equal(initialisedBucket(join(scratch, 'fresh')), null);

  const dir = join(scratch, 'used');
  mkdirSync(join(dir, '.terraform'), { recursive: true });
  writeFileSync(
    join(dir, '.terraform', 'terraform.tfstate'),
    JSON.stringify({
      backend: { type: 's3', config: { bucket: 'state-bucket' } },
    }),
  );
  assert.equal(initialisedBucket(dir), 'state-bucket');

  writeFileSync(join(dir, '.terraform', 'terraform.tfstate'), 'not json');
  assert.equal(initialisedBucket(dir), null);
});
