import {
  CAPABILITY_BLOCKED_SENDERS,
  CAPABILITY_PICTURE_SENDERS,
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

/*
 * Picture senders: the addresses whose mail is shown with its pictures. A
 * picture kept on another site tells whoever sent it that the message was
 * opened, and when, and from where: it is loaded for those the person has
 * said may know. Nothing is done about it here; it is kept so that every
 * program the person reads mail in knows the same.
 */
export const PICTURE_SENDER = 'PictureSender';

/** A list of addresses, and of whole domains, that an account keeps. */
interface Kind {
  type: string;
  capability: string;
  /** What the account is told its limit is called. */
  limit: string;
  /** What to say of an address that is on it already. */
  already: string;
  /** What to say when it is full. */
  full: string;
  /** What to say when one is changed, which none can be. */
  fixed: string;
}

const BLOCKED: Kind = {
  type: BLOCKED_SENDER,
  capability: CAPABILITY_BLOCKED_SENDERS,
  limit: 'maxBlockedSenders',
  already: 'This address is blocked already',
  full: 'No more than 500 blocked senders',
  fixed: 'A blocked sender is removed and added again, not changed',
};

const PICTURES: Kind = {
  type: PICTURE_SENDER,
  capability: CAPABILITY_PICTURE_SENDERS,
  limit: 'maxPictureSenders',
  already: 'Pictures from this address are shown already',
  full: 'No more than 500 senders whose pictures are shown',
  fixed: 'A sender is removed and added again, not changed',
};

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

async function createListed(
  kind: Kind,
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
  const all = await ctx.store.list(ctx.auth.accountId, kind.type);
  if (
    all.some(
      (record) => (record.value as unknown as BlockedValue).address === address,
    )
  ) {
    throw invalid(['address'], kind.already);
  }
  if (all.length >= MAX_BLOCKED) {
    throw new SetFailure('overQuota', kind.full);
  }
  const id = generateId('bs');
  await commit(ctx, [
    { kind: 'create', type: kind.type, id, value: { address } },
  ]);
  // What was sent in capitals or with space around it is kept without.
  return { id, ...(given === address ? {} : { address }) };
}

/** An address is what is listed: another one is another entry. */
async function updateListed(kind: Kind): Promise<null> {
  throw new SetFailure('invalidProperties', kind.fixed, {
    properties: ['address'],
  });
}

async function destroyListed(
  kind: Kind,
  ctx: MethodContext,
  id: string,
): Promise<void> {
  const [record] = await ctx.store.get(ctx.auth.accountId, kind.type, [id]);
  if (!record) throw new SetFailure('notFound');
  await commit(ctx, [
    {
      kind: 'destroy',
      type: kind.type,
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

const methodsOf = (kind: Kind): Record<string, MethodHandler> => ({
  [`${kind.type}/get`]: async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, PROPERTIES);
    const { state, records, notFound } = await loadForGet(
      ctx,
      kind.type,
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

  [`${kind.type}/changes`]: async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, kind.type, rawArgs)),
  }),

  [`${kind.type}/set`]: async (rawArgs, ctx) => ({
    ...(await standardSet(
      ctx,
      {
        type: kind.type,
        create: (context, input) => createListed(kind, context, input),
        update: () => updateListed(kind),
        destroy: (context, id) => destroyListed(kind, context, id),
      },
      parseArguments(SetArgumentsSchema, rawArgs),
    )),
  }),
});

const moduleOf = (name: string, kind: Kind): JmapModule => ({
  name,
  capabilities: { [kind.capability]: {} },
  accountCapabilities: () => ({
    [kind.capability]: { [kind.limit]: MAX_BLOCKED },
  }),
  methods: Object.fromEntries(
    Object.entries(methodsOf(kind)).map(([method, handler]) => [
      method,
      { capability: kind.capability, handler },
    ]),
  ),
  pushedTypes: [kind.type],
});

/** Blocked senders for a JMAP server: whose mail is filed as junk when it arrives. */
export function blockedSendersModule(): JmapModule {
  return moduleOf('blocked-senders', BLOCKED);
}

/** Picture senders for a JMAP server: whose mail is shown with its pictures. */
export function pictureSendersModule(): JmapModule {
  return moduleOf('picture-senders', PICTURES);
}
