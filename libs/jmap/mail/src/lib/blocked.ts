import {
  CAPABILITY_BLOCKED_SENDERS,
  GetArgumentsSchema,
  SetArgumentsSchema,
  SetFailure,
} from '@mailless/jmap-core';
import {
  commit,
  generateId,
  loadForGet,
  parseArguments,
  pick,
  requireAccount,
  selectProperties,
  standardChanges,
  standardSet,
  toChangesResponse,
  type JmapModule,
  type MethodContext,
  type MethodHandler,
} from '@mailless/jmap-engine';

/*
 * Blocked senders: the addresses someone wants no more mail from. Mail that
 * arrives from one of them is filed as junk, where it can still be found: it
 * is not turned away, so that whoever wrote learns nothing from it.
 *
 * JMAP's own answer to this is a Sieve script (RFC 9661), which says far more
 * than "not from them" and asks far more of a client. This is the small part
 * of it, under a capability of its own that a client which does not know it
 * never names.
 */

export const BLOCKED_SENDER = 'BlockedSender';

const MAX_BLOCKED = 500;
const PROPERTIES = ['id', 'address'];
/** One mailbox, or with nothing before the `@` everyone at a domain. */
const ADDRESS = /^[^@\s]*@[^@\s]+\.[^@\s]+$/;

interface BlockedValue {
  /** In small letters: `someone@example.com`, or `@example.com` for all of it. */
  address: string;
}

const invalid = (properties: string[], description: string): SetFailure =>
  new SetFailure('invalidProperties', description, { properties });

async function createBlocked(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  const unknown = Object.keys(input).filter(
    (property) => property !== 'address',
  );
  if (unknown.length > 0) {
    throw invalid(unknown, 'These properties cannot be set');
  }
  const given = typeof input['address'] === 'string' ? input['address'] : '';
  const address = given.trim().toLowerCase();
  if (!ADDRESS.test(address) || address.length > 320) {
    throw invalid(
      ['address'],
      'An address, or @ and a domain for everyone at it',
    );
  }
  const all = await ctx.store.list(ctx.auth.accountId, BLOCKED_SENDER);
  if (
    all.some(
      (record) => (record.value as unknown as BlockedValue).address === address,
    )
  ) {
    throw invalid(['address'], 'This address is blocked already');
  }
  if (all.length >= MAX_BLOCKED) {
    throw new SetFailure(
      'overQuota',
      `No more than ${MAX_BLOCKED} blocked senders`,
    );
  }
  const id = generateId('bs');
  await commit(ctx, [
    { kind: 'create', type: BLOCKED_SENDER, id, value: { address } },
  ]);
  // What was sent in capitals or with space around it is kept without.
  return { id, ...(given === address ? {} : { address }) };
}

/** An address is what is blocked: another one is another entry. */
async function updateBlocked(): Promise<null> {
  throw new SetFailure(
    'invalidProperties',
    'A blocked sender is removed and added again, not changed',
    { properties: ['address'] },
  );
}

async function destroyBlocked(ctx: MethodContext, id: string): Promise<void> {
  const [record] = await ctx.store.get(ctx.auth.accountId, BLOCKED_SENDER, [
    id,
  ]);
  if (!record) throw new SetFailure('notFound');
  await commit(ctx, [
    {
      kind: 'destroy',
      type: BLOCKED_SENDER,
      id,
      expectedVersion: record.version,
    },
  ]);
}

/** Whether mail from any of these addresses is to be filed as junk. */
export async function senderBlocked(
  ctx: MethodContext,
  from: readonly { email: string }[] | null,
): Promise<boolean> {
  const senders = (from ?? [])
    .map((sender) => sender.email.trim().toLowerCase())
    .filter((email) => email.includes('@'));
  if (senders.length === 0) return false;
  const blocked = new Set(
    (await ctx.store.list(ctx.auth.accountId, BLOCKED_SENDER)).map(
      (record) => (record.value as unknown as BlockedValue).address,
    ),
  );
  if (blocked.size === 0) return false;
  return senders.some(
    (email) =>
      blocked.has(email) || blocked.has(email.slice(email.lastIndexOf('@'))),
  );
}

const blockedMethods: Record<string, MethodHandler> = {
  'BlockedSender/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, PROPERTIES);
    const { state, records, notFound } = await loadForGet(
      ctx,
      BLOCKED_SENDER,
      args.ids,
    );
    return {
      accountId,
      state,
      list: records.map((record) =>
        pick(
          {
            id: record.id,
            address: (record.value as unknown as BlockedValue).address,
          },
          properties,
        ),
      ),
      notFound,
    };
  },

  'BlockedSender/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, BLOCKED_SENDER, rawArgs)),
  }),

  'BlockedSender/set': async (rawArgs, ctx) => ({
    ...(await standardSet(
      ctx,
      {
        type: BLOCKED_SENDER,
        create: createBlocked,
        update: updateBlocked,
        destroy: destroyBlocked,
      },
      parseArguments(SetArgumentsSchema, rawArgs),
    )),
  }),
};

/** Blocked senders for a JMAP server: whose mail is filed as junk when it arrives. */
export function blockedSendersModule(): JmapModule {
  return {
    name: 'blocked-senders',
    capabilities: { [CAPABILITY_BLOCKED_SENDERS]: {} },
    accountCapabilities: () => ({
      [CAPABILITY_BLOCKED_SENDERS]: { maxBlockedSenders: MAX_BLOCKED },
    }),
    methods: Object.fromEntries(
      Object.entries(blockedMethods).map(([name, handler]) => [
        name,
        { capability: CAPABILITY_BLOCKED_SENDERS, handler },
      ]),
    ),
    pushedTypes: [BLOCKED_SENDER],
  };
}
