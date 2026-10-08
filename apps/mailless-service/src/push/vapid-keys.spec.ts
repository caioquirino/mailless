import { readOrCreateVapidKeys, readVapidKeys } from './vapid-keys.js';

const named = (name: string) => Object.assign(new Error(name), { name });

/** A parameter store holding at most one value, as SSM answers. */
function fakeSsm(initial?: string) {
  let value = initial;
  const calls: string[] = [];
  /** Run once, between the first read and the write: another function getting there first. */
  let beforePut: (() => void) | undefined;
  const ssm = {
    send: async (command: {
      constructor: { name: string };
      input: unknown;
    }) => {
      const kind = command.constructor.name;
      const input = command.input as Record<string, unknown>;
      calls.push(kind);
      if (kind === 'GetParameterCommand') {
        expect(input['WithDecryption']).toBe(true);
        if (value === undefined) throw named('ParameterNotFound');
        return { Parameter: { Value: value } };
      }
      beforePut?.();
      beforePut = undefined;
      expect(input).toMatchObject({ Type: 'SecureString', Overwrite: false });
      if (value !== undefined) throw named('ParameterAlreadyExists');
      value = input['Value'] as string;
      return {};
    },
  } as never;
  return {
    ssm,
    calls,
    stored: () => value,
    raceWith: (other: string) => {
      beforePut = () => {
        value = other;
      };
    },
  };
}

const pair = (name: string) => ({
  publicKey: `public-${name}`,
  privateKey: `private-${name}`,
});

describe('VAPID keys', () => {
  it('makes a pair the first time, and reads the same one after', async () => {
    const fake = fakeSsm();
    const store = {
      ssm: fake.ssm,
      parameter: '/mailless/vapid-keys',
      generate: async () => pair('first'),
    };
    expect(await readVapidKeys(store)).toBeUndefined();
    expect(await readOrCreateVapidKeys(store)).toEqual(pair('first'));
    expect(JSON.parse(fake.stored() as string)).toEqual(pair('first'));

    const again = { ...store, generate: async () => pair('second') };
    expect(await readOrCreateVapidKeys(again)).toEqual(pair('first'));
    expect(await readVapidKeys(again)).toEqual(pair('first'));
  });

  it('takes the pair another function wrote first, and not its own', async () => {
    const fake = fakeSsm();
    fake.raceWith(JSON.stringify(pair('theirs')));
    expect(
      await readOrCreateVapidKeys({
        ssm: fake.ssm,
        parameter: 'p',
        generate: async () => pair('mine'),
      }),
    ).toEqual(pair('theirs'));
    expect(fake.calls).toEqual([
      'GetParameterCommand',
      'PutParameterCommand',
      'GetParameterCommand',
    ]);
  });

  it('fails, and replaces nothing, when the parameter holds something else or cannot be read', async () => {
    const broken = fakeSsm('{"something":"else"}');
    const store = {
      ssm: broken.ssm,
      parameter: 'p',
      generate: async () => pair('new'),
    };
    await expect(readOrCreateVapidKeys(store)).rejects.toThrow(/does not hold/);
    await expect(readVapidKeys(store)).rejects.toThrow(/does not hold/);
    expect(broken.stored()).toBe('{"something":"else"}');

    const denied = {
      send: async () => {
        throw named('AccessDeniedException');
      },
    } as never;
    await expect(
      readVapidKeys({ ssm: denied, parameter: 'p' }),
    ).rejects.toThrow('AccessDeniedException');
  });
});
