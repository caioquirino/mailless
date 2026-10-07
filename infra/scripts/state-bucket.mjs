// Finds or creates the S3 bucket that holds this stack's Terraform state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';

/** Reads the two settings needed before Terraform can run, from a .tfvars file. */
export function readSettings(tfvarsPath) {
  if (!existsSync(tfvarsPath)) {
    throw new Error(
      `${tfvarsPath} is missing: copy terraform.tfvars.example and fill it in.`,
    );
  }
  const text = readFileSync(tfvarsPath, 'utf8');
  const value = (key) =>
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text)?.[1];

  const region = value('region');
  if (!region) {
    throw new Error(
      `${tfvarsPath} must set region, for example region = "eu-west-1".`,
    );
  }
  return { region, name: value('name') ?? 'mailless' };
}

export function stateBucketName({ name, accountId, region }) {
  return `${name}-terraform-state-${accountId}-${region}`;
}

/** The state bucket this working directory was last initialised against, if any. */
export function initialisedBucket(infraDir) {
  try {
    const state = JSON.parse(
      readFileSync(join(infraDir, '.terraform', 'terraform.tfstate'), 'utf8'),
    );
    return state?.backend?.config?.bucket ?? null;
  } catch {
    return null;
  }
}

function status(error) {
  return error?.$metadata?.httpStatusCode;
}

/**
 * Makes sure the bucket exists and is private, versioned, encrypted and
 * TLS-only. Returns 'exists' or 'created'. The settings are applied in both
 * cases, so a run that was interrupted half-way is completed by the next one.
 */
export async function ensureStateBucket(
  s3,
  bucket,
  region,
  { name = 'mailless' } = {},
) {
  let result = 'exists';
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (status(error) === 403) {
      throw new Error(
        `The bucket ${bucket} exists but these credentials cannot access it. ` +
          'Check that you are using the right AWS account.',
      );
    }
    if (status(error) !== 404) throw error;

    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 is the one region that must not be named here.
        ...(region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region } }),
      }),
    );
    result = 'created';
  }

  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [
          { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    }),
  );
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          },
        ],
      }),
    }),
  );
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-old-state-versions',
            Status: 'Enabled',
            Filter: {},
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          },
        ],
      },
    }),
  );
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: {
        TagSet: [
          { Key: 'Project', Value: name },
          { Key: 'ManagedBy', Value: 'infra/scripts/init.mjs' },
        ],
      },
    }),
  );
  return result;
}
