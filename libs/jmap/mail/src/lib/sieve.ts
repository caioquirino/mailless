import {
  CAPABILITY_SIEVE,
  GetArgumentsSchema,
  parseSieve,
  runSieve,
  SetArgumentsSchema,
  SetFailure,
  sieveRuleKeyword,
  type EmailHeader,
  type SieveOutcome,
} from '@mailless/jmap-core';
import {
  commit,
  generateId,
  loadForGet,
  parseArguments,
  pick,
  requireAccount,
  resolveCreationReference,
  selectProperties,
  standardChanges,
  standardSet,
  toChangesResponse,
  type JmapModule,
  type MethodContext,
  type MethodHandler,
} from '@mailless/jmap-engine';
import { z } from 'zod';
import { headerAsText } from './headers.js';
import { parseMessage } from './mime.js';
import { MAILBOX, type MailboxRecord } from './model.js';

/*
 * Sieve scripts (RFC 9661): what an account wants done with its mail as it
 * arrives, in the language for it (RFC 5228). An account keeps as many as it
 * likes and has at most one in use. The one in use is run on each message
 * that arrives and was headed for the inbox; what it says is done, and the
 * message is marked with which of its filters did it.
 *
 * A script is kept with the account's other records, not as a blob: it is
 * small, and read on every delivery. It is still read and written as one,
 * as the standard has it, under a blob id that changes when the script does.
 */

export const SIEVE_SCRIPT = 'SieveScript';

const MAX_SCRIPTS = 20;
/** More than anyone writes by hand, and well inside what one record holds. */
const MAX_SCRIPT_OCTETS = 100_000;
const PROPERTIES = ['id', 'name', 'blobId', 'isActive'];
// Not the shape of a part of a message, which ends in a hyphen and a number.
const BLOB = /^([A-Za-z0-9]+)_r(\d+)_sieve$/;

interface ScriptValue {
  name: string | null;
  content: string;
  isActive: boolean;
  /** Counted up when the content changes: part of the blob id, which changes with it. */
  revision: number;
}

type ScriptRecord = { id: string; version: number; value: ScriptValue };

const blobIdOf = (id: string, value: ScriptValue) =>
  `${id}_r${value.revision}_sieve`;

const shown = (record: ScriptRecord) => ({
  id: record.id,
  name: record.value.name,
  blobId: blobIdOf(record.id, record.value),
  isActive: record.value.isActive,
});

const invalid = (properties: string[], description: string): SetFailure =>
  new SetFailure('invalidProperties', description, { properties });

async function scripts(ctx: MethodContext): Promise<ScriptRecord[]> {
  return (await ctx.store.list(
    ctx.auth.accountId,
    SIEVE_SCRIPT,
  )) as unknown as ScriptRecord[];
}

/** What is wrong with a script, as one line; null when nothing is. */
function problemWith(content: string): string | null {
  const [problem] = parseSieve(content).problems;
  return problem ? `Line ${problem.line}: ${problem.message}` : null;
}

/** The script a blob holds, when it is one that can be kept. */
async function contentOf(ctx: MethodContext, blobId: unknown): Promise<string> {
  const data = typeof blobId === 'string' ? await ctx.readBlob(blobId) : null;
  if (!data) throw invalid(['blobId'], 'No such blob');
  if (data.length > MAX_SCRIPT_OCTETS) {
    throw new SetFailure('tooLarge', 'The script is too long');
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new SetFailure('invalidSieve', 'The script is not text');
  }
  const problem = problemWith(content);
  if (problem) throw new SetFailure('invalidSieve', problem);
  return content;
}

function nameOf(given: unknown, others: ScriptRecord[]): string | null {
  if (given === null || given === undefined) return null;
  if (typeof given !== 'string' || given.length < 1 || given.length > 255) {
    throw invalid(['name'], 'A name of 1 to 255 characters');
  }
  if (others.some((each) => each.value.name === given)) {
    throw new SetFailure('alreadyExists', 'Another script has this name');
  }
  return given;
}

async function createScript(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  const unknown = Object.keys(input).filter(
    (property) => property !== 'name' && property !== 'blobId',
  );
  if (unknown.length > 0) {
    throw invalid(unknown, 'These properties cannot be set');
  }
  const all = await scripts(ctx);
  if (all.length >= MAX_SCRIPTS) {
    throw new SetFailure('overQuota', `No more than ${MAX_SCRIPTS} scripts`);
  }
  const value: ScriptValue = {
    name: nameOf(input['name'], all),
    content: await contentOf(ctx, input['blobId']),
    isActive: false,
    revision: 1,
  };
  const id = generateId('sv');
  await commit(ctx, [
    {
      kind: 'create',
      type: SIEVE_SCRIPT,
      id,
      value: value as unknown as Record<string, unknown>,
    },
  ]);
  return { id, blobId: blobIdOf(id, value), isActive: false };
}

async function updateScript(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const all = await scripts(ctx);
  const record = all.find((each) => each.id === id);
  if (!record) throw new SetFailure('notFound');
  const unknown = Object.keys(patch).filter(
    (property) => property !== 'name' && property !== 'blobId',
  );
  if (unknown.length > 0) {
    throw invalid(unknown, 'These properties cannot be set');
  }
  const next: ScriptValue = { ...record.value };
  if ('name' in patch) {
    next.name = nameOf(
      patch['name'],
      all.filter((each) => each.id !== id),
    );
  }
  const same = patch['blobId'] === blobIdOf(id, record.value);
  if ('blobId' in patch && !same) {
    next.content = await contentOf(ctx, patch['blobId']);
    next.revision = record.value.revision + 1;
  }
  await commit(ctx, [
    {
      kind: 'update',
      type: SIEVE_SCRIPT,
      id,
      value: next as unknown as Record<string, unknown>,
      expectedVersion: record.version,
    },
  ]);
  // The content is kept under a blob id of this server's own.
  return 'blobId' in patch && !same ? { blobId: blobIdOf(id, next) } : null;
}

async function destroyScript(ctx: MethodContext, id: string): Promise<void> {
  const record = (await scripts(ctx)).find((each) => each.id === id);
  if (!record) throw new SetFailure('notFound');
  if (record.value.isActive) {
    throw new SetFailure('sieveIsActive', 'The script in use is not removed');
  }
  await commit(ctx, [
    {
      kind: 'destroy',
      type: SIEVE_SCRIPT,
      id,
      expectedVersion: record.version,
    },
  ]);
}

/** Puts one script in use, or none. Returns what changed, by id. */
async function activate(
  ctx: MethodContext,
  id: string | null,
): Promise<Record<string, { isActive: boolean }>> {
  const all = await scripts(ctx);
  if (id !== null && !all.some((each) => each.id === id)) return {};
  const changed = all.filter(
    (each) => each.value.isActive !== (each.id === id),
  );
  if (changed.length === 0) return {};
  await commit(
    ctx,
    changed.map((record) => ({
      kind: 'update' as const,
      type: SIEVE_SCRIPT,
      id: record.id,
      value: {
        ...record.value,
        isActive: record.id === id,
      } as unknown as Record<string, unknown>,
      expectedVersion: record.version,
    })),
  );
  return Object.fromEntries(
    changed.map((record) => [record.id, { isActive: record.id === id }]),
  );
}

const ScriptSetArgumentsSchema = SetArgumentsSchema.extend({
  onSuccessActivateScript: z.string().nullish(),
  onSuccessDeactivateScript: z.boolean().nullish(),
});

const ValidateArgumentsSchema = z.strictObject({
  accountId: z.string(),
  blobId: z.string(),
});

const TestArgumentsSchema = z.strictObject({
  accountId: z.string(),
  scriptBlobId: z.string(),
  emailBlobIds: z.array(z.string()).max(500),
  envelope: z.unknown().optional(),
  lastVacationResponse: z.unknown().optional(),
});

/** What a script is given of a message. */
function messageFor(headers: readonly EmailHeader[], size: number) {
  return {
    headers: headers.map(
      ({ name, value }) => [name, headerAsText(value)] as const,
    ),
    size,
  };
}

/** What a script would do, as a list of what it does: the form a trial is told in. */
function actionsOf(outcome: SieveOutcome): Array<[string, object]> {
  const actions: Array<[string, object]> = outcome.deliveries.map((delivery) =>
    delivery.mailbox === null
      ? ['keep', { flags: delivery.flags }]
      : [
          'fileinto',
          {
            mailbox: delivery.mailbox,
            mailboxId: delivery.mailboxId,
            flags: delivery.flags,
          },
        ],
  );
  if (outcome.discarded) actions.push(['discard', {}]);
  // Not the standard's: which of the script's named filters did it.
  actions.push(['mailless:rules', { names: outcome.rules }]);
  return actions;
}

const sieveMethods: Record<string, MethodHandler> = {
  'SieveScript/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, PROPERTIES);
    const { state, records, notFound } = await loadForGet(
      ctx,
      SIEVE_SCRIPT,
      args.ids,
    );
    return {
      accountId,
      state,
      list: records.map((record) =>
        pick(shown(record as unknown as ScriptRecord), properties),
      ),
      notFound,
    };
  },

  'SieveScript/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, SIEVE_SCRIPT, rawArgs)),
  }),

  'SieveScript/set': async (rawArgs, ctx) => {
    const args = parseArguments(ScriptSetArgumentsSchema, rawArgs);
    const response = await standardSet(
      ctx,
      {
        type: SIEVE_SCRIPT,
        create: createScript,
        update: updateScript,
        destroy: destroyScript,
      },
      args,
    );
    const succeeded =
      !response.notCreated && !response.notUpdated && !response.notDestroyed;
    if (!succeeded) return { ...response };
    const wanted = args.onSuccessActivateScript;
    const changed =
      typeof wanted === 'string'
        ? await activate(ctx, resolveCreationReference(ctx, wanted) ?? wanted)
        : args.onSuccessDeactivateScript
          ? await activate(ctx, null)
          : {};
    if (Object.keys(changed).length === 0) return { ...response };
    const created = { ...response.created };
    const updated = { ...response.updated };
    for (const [id, change] of Object.entries(changed)) {
      const made = Object.entries(created).find(([, each]) => each?.id === id);
      if (made) created[made[0]] = { ...made[1], ...change } as never;
      else updated[id] = { ...updated[id], ...change };
    }
    return {
      ...response,
      // What was activated is a change of its own, with a state of its own.
      newState: (await loadForGet(ctx, SIEVE_SCRIPT, [])).state,
      ...(response.created ? { created } : {}),
      updated,
    };
  },

  'SieveScript/validate': async (rawArgs, ctx) => {
    const args = parseArguments(ValidateArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    try {
      await contentOf(ctx, args.blobId);
      return { accountId, error: null };
    } catch (error) {
      if (!(error instanceof SetFailure)) throw error;
      return {
        accountId,
        error: error.error,
      };
    }
  },

  /** What a script would do with some messages. Nothing is done: it is only said. */
  'SieveScript/test': async (rawArgs, ctx) => {
    const args = parseArguments(TestArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const script = parseSieve(await contentOf(ctx, args.scriptBlobId));
    const completed: Record<string, Array<[string, object]>> = {};
    const notCompleted: Record<string, { type: string }> = {};
    for (const blobId of args.emailBlobIds) {
      const raw = await ctx.readBlob(blobId);
      if (!raw) {
        notCompleted[blobId] = { type: 'blobNotFound' };
        continue;
      }
      try {
        const parsed = await parseMessage(raw);
        completed[blobId] = actionsOf(
          runSieve(script, messageFor(parsed.metadata.headers, raw.length)),
        );
      } catch {
        notCompleted[blobId] = { type: 'invalidEmail' };
      }
    }
    return {
      accountId,
      completed: Object.keys(completed).length > 0 ? completed : null,
      notCompleted: Object.keys(notCompleted).length > 0 ? notCompleted : null,
    };
  },
};

/** What the flags a script sets are as keywords. Those that mean nothing for mail that just arrived are left out. */
function keywordsOf(flags: readonly string[]): Record<string, true> {
  const keywords: Record<string, true> = {};
  for (const flag of flags) {
    const lower = flag.trim().toLowerCase();
    const keyword = lower.startsWith('\\') ? `$${lower.slice(1)}` : lower;
    if (
      keyword === '$deleted' ||
      keyword === '$draft' ||
      keyword === '$recent'
    ) {
      continue;
    }
    // What a keyword may be made of (RFC 8621 §4.1.1).
    if (/^[\x21-\x7e]{1,255}$/.test(keyword) && !/[()\]{%*"\\]/.test(keyword)) {
      keywords[keyword] = true;
    }
  }
  return keywords;
}

/** The mailbox a script means: by what the server knows it as, or by its name, with those above it before a "/". */
function mailboxFor(
  mailboxes: readonly MailboxRecord[],
  name: string,
  id: string | null,
): MailboxRecord | undefined {
  const byId = id ? mailboxes.find((each) => each.id === id) : undefined;
  if (byId) return byId;
  const path = (mailbox: MailboxRecord): string => {
    const parent = mailbox.value.parentId
      ? mailboxes.find((each) => each.id === mailbox.value.parentId)
      : undefined;
    return parent
      ? `${path(parent)}/${mailbox.value.name}`
      : mailbox.value.name;
  };
  const wanted = name.trim().toLowerCase();
  return (
    mailboxes.find((each) => path(each).toLowerCase() === wanted) ??
    // INBOX is the inbox, whatever it is called here (RFC 5228 §4.1).
    (wanted === 'inbox'
      ? mailboxes.find((each) => each.value.role === 'inbox')
      : undefined)
  );
}

/**
 * What the account's script in use says to do with a message that has just
 * arrived for its inbox: where to keep it and with which keywords, or null
 * to leave it as it is. A script that cannot be run changes nothing: mail
 * is never lost to a filter.
 */
export async function filterDelivery(
  ctx: MethodContext,
  headers: readonly EmailHeader[],
  size: number,
): Promise<{
  mailboxIds: Record<string, true> | null;
  keywords: Record<string, true>;
} | null> {
  const active = (await scripts(ctx)).find((each) => each.value.isActive);
  if (!active) return null;
  const script = parseSieve(active.value.content);
  if (script.problems.length > 0) return null;
  const outcome = runSieve(script, messageFor(headers, size));
  if (outcome.rules.length === 0 && !outcome.discarded) {
    const [only] = outcome.deliveries;
    if (
      outcome.deliveries.length === 1 &&
      only?.mailbox === null &&
      only.flags.length === 0
    ) {
      return null;
    }
  }
  const mailboxes = (await ctx.store.list(
    ctx.auth.accountId,
    MAILBOX,
  )) as unknown as MailboxRecord[];
  const mailboxIds: Record<string, true> = {};
  const keywords: Record<string, true> = {};
  let inbox = false;
  for (const delivery of outcome.deliveries) {
    const into =
      delivery.mailbox === null
        ? undefined
        : mailboxFor(mailboxes, delivery.mailbox, delivery.mailboxId);
    // A folder that is not there any more: kept where it would have gone.
    if (into) mailboxIds[into.id] = true;
    else inbox = true;
    Object.assign(keywords, keywordsOf(delivery.flags));
  }
  if (outcome.discarded) {
    // Thrown away is put in the trash, read: there to be found for as long as the trash keeps it.
    const trash = mailboxes.find((each) => each.value.role === 'trash');
    if (trash) mailboxIds[trash.id] = true;
    else inbox = true;
    keywords['$seen'] = true;
  }
  for (const name of outcome.rules) keywords[sieveRuleKeyword(name)] = true;
  const moved = Object.keys(mailboxIds).length > 0;
  if (inbox && moved) {
    const home = mailboxes.find((each) => each.value.role === 'inbox');
    if (home) mailboxIds[home.id] = true;
  }
  return { mailboxIds: moved ? mailboxIds : null, keywords };
}

/** Sieve scripts for a JMAP server: kept, checked, tried, and run on what arrives. */
export function sieveModule(): JmapModule {
  return {
    name: 'sieve',
    capabilities: { [CAPABILITY_SIEVE]: {} },
    accountCapabilities: () => ({
      [CAPABILITY_SIEVE]: {
        maxSizeScriptName: 255,
        maxSizeScript: MAX_SCRIPT_OCTETS,
        maxNumberScripts: MAX_SCRIPTS,
        maxNumberRedirects: 0,
        sieveExtensions: ['fileinto', 'imap4flags', 'mailboxid', 'copy'],
        notificationMethods: null,
        externalLists: null,
      },
    }),
    methods: Object.fromEntries(
      Object.entries(sieveMethods).map(([name, handler]) => [
        name,
        { capability: CAPABILITY_SIEVE, handler },
      ]),
    ),
    pushedTypes: [SIEVE_SCRIPT],
    readBlob: async (ctx, blobId) => {
      const found = BLOB.exec(blobId);
      if (!found) return undefined;
      const [record] = (await ctx.store.get(ctx.auth.accountId, SIEVE_SCRIPT, [
        found[1] as string,
      ])) as unknown as ScriptRecord[];
      return record && String(record.value.revision) === found[2]
        ? new TextEncoder().encode(record.value.content)
        : undefined;
    },
  };
}
