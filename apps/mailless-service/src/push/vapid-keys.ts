import {
  GetParameterCommand,
  PutParameterCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';
import { generateVapidKeys, type VapidKeys } from '@mailless/jmap-server';

export interface VapidKeyStore {
  ssm: Pick<SSMClient, 'send'>;
  /** The name of the encrypted parameter the pair is kept in. */
  parameter: string;
  /** For tests: how a new pair is made. */
  generate?: () => Promise<VapidKeys>;
}

const errorName = (error: unknown): string =>
  (error as { name?: string } | null)?.name ?? '';

async function read({
  ssm,
  parameter,
}: VapidKeyStore): Promise<VapidKeys | undefined> {
  let text: string | undefined;
  try {
    const response = await ssm.send(
      new GetParameterCommand({ Name: parameter, WithDecryption: true }),
    );
    text = response.Parameter?.Value;
  } catch (error) {
    if (errorName(error) === 'ParameterNotFound') return undefined;
    throw error;
  }
  const parsed = JSON.parse(text ?? 'null') as Partial<VapidKeys> | null;
  if (
    typeof parsed?.publicKey !== 'string' ||
    typeof parsed.privateKey !== 'string'
  ) {
    // Not replaced with a new pair: that would end every push subscription.
    throw new Error(
      `The parameter ${parameter} does not hold a VAPID key pair`,
    );
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

/**
 * The deployment's VAPID key pair, or undefined when none has been made yet.
 * For the function that only sends pushes: it never makes one.
 */
export function readVapidKeys(
  store: VapidKeyStore,
): Promise<VapidKeys | undefined> {
  return read(store);
}

/**
 * The deployment's VAPID key pair, made the first time it is asked for. It is
 * written only if there is none: of two functions starting at once, one
 * writes and the other reads what was written, so there is only ever one
 * pair. It is kept as an encrypted parameter and is in no other place: not in
 * the configuration, not in Terraform's state, not in a log.
 */
export async function readOrCreateVapidKeys(
  store: VapidKeyStore,
): Promise<VapidKeys> {
  const existing = await read(store);
  if (existing) return existing;
  const keys = await (store.generate ?? generateVapidKeys)();
  try {
    await store.ssm.send(
      new PutParameterCommand({
        Name: store.parameter,
        Description:
          'VAPID key pair for web push. Replacing it ends every push subscription.',
        Type: 'SecureString',
        Value: JSON.stringify(keys),
        Overwrite: false,
      }),
    );
    return keys;
  } catch (error) {
    if (errorName(error) !== 'ParameterAlreadyExists') throw error;
  }
  const written = await read(store);
  if (!written) {
    throw new Error(`The parameter ${store.parameter} could not be read back`);
  }
  return written;
}
