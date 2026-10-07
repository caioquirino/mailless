// `terraform init` for the main stack, creating the state bucket first when needed.
// Run through Nx: `pnpm infra init` (plan and apply depend on it).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  ensureStateBucket,
  initialisedBucket,
  readSettings,
  stateBucketName,
} from './state-bucket.mjs';

const infraDir = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const { region, name } = readSettings(join(infraDir, 'terraform.tfvars'));

  let accountId;
  try {
    const identity = await new STSClient({ region }).send(
      new GetCallerIdentityCommand({}),
    );
    accountId = identity.Account;
  } catch (error) {
    throw new Error(
      `Could not identify the AWS account (${error.name}). ` +
        'Make sure AWS credentials are available in this shell.',
    );
  }

  const bucket = stateBucketName({ name, accountId, region });
  const previous = initialisedBucket(infraDir);

  if (previous === bucket) {
    // This directory already runs against the bucket, so it is known to exist.
    console.log(`Terraform state: s3://${bucket} (already initialised)`);
  } else {
    const result = await ensureStateBucket(
      new S3Client({ region }),
      bucket,
      region,
      { name },
    );
    console.log(
      result === 'created'
        ? `Terraform state: created s3://${bucket} in account ${accountId}`
        : `Terraform state: s3://${bucket}`,
    );
  }

  const terraform = spawnSync(
    'terraform',
    [
      'init',
      '-input=false',
      `-backend-config=bucket=${bucket}`,
      `-backend-config=region=${region}`,
      // A different bucket means a different account or region: start from its state, do not copy ours over.
      ...(previous !== null && previous !== bucket ? ['-reconfigure'] : []),
    ],
    { cwd: infraDir, stdio: 'inherit' },
  );
  if (terraform.error) throw terraform.error;
  process.exit(terraform.status ?? 1);
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
