import {
  applyPatch,
  CAPABILITY_TAGS,
  GetArgumentsSchema,
  PatchError,
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
 * Tags: the names and colours someone gives to keywords of their own. JMAP
 * has keywords on messages (RFC 8621 §4.1.1) and nothing that says what a
 * keyword is called or looks like, so that what one device names is not known
 * to the next. A Tag is that: a name, a colour, and the keyword it stands for.
 * Putting it on a message is setting that keyword, as for any other.
 *
 * Not part of any RFC: it has a capability of its own, which a client that
 * does not know it never names.
 */

export const TAG = 'Tag';

/** A keyword is made for each tag, so that giving a tag another name changes no message. */
const KEYWORD_PREFIX = 'mailless-tag-';
const MAX_TAGS = 200;
const MAX_NAME_LENGTH = 60;
const COLOR = /^#[0-9a-f]{6}$/;
const PROPERTIES = ['id', 'name', 'color', 'keyword'];

interface TagValue {
  name: string;
  /** As `#rrggbb`, in small letters. */
  color: string;
}

const invalid = (properties: string[], description: string): SetFailure =>
  new SetFailure('invalidProperties', description, { properties });

const describe = (id: string, value: TagValue) => ({
  id,
  name: value.name,
  color: value.color,
  keyword: `${KEYWORD_PREFIX}${id}`,
});

/** Takes what a client may set from a whole tag, or says what is wrong with it. */
function tagValue(tag: Record<string, unknown>): TagValue {
  const problems: string[] = [];
  const name = typeof tag['name'] === 'string' ? tag['name'].trim() : '';
  if (name === '' || [...name].length > MAX_NAME_LENGTH) problems.push('name');
  const color = tag['color'];
  if (typeof color !== 'string' || !COLOR.test(color)) problems.push('color');
  for (const property of Object.keys(tag)) {
    if (!PROPERTIES.includes(property)) problems.push(property);
  }
  if (problems.length > 0) {
    throw invalid(problems, 'These properties are missing or not valid');
  }
  return { name, color: color as string };
}

/** Two tags of one name could not be told apart. */
async function requireOwnName(
  ctx: MethodContext,
  name: string,
  except?: string,
): Promise<number> {
  const all = await ctx.store.list(ctx.auth.accountId, TAG);
  const wanted = name.toLowerCase();
  if (
    all.some(
      (record) =>
        record.id !== except &&
        (record.value as unknown as TagValue).name.toLowerCase() === wanted,
    )
  ) {
    throw invalid(['name'], 'There is a tag with this name already');
  }
  return all.length;
}

async function createTag(
  ctx: MethodContext,
  input: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  if (input['id'] !== undefined || input['keyword'] !== undefined) {
    throw invalid(
      ['id', 'keyword'].filter((property) => input[property] !== undefined),
      'These properties are set by the server',
    );
  }
  const value = tagValue(input);
  if ((await requireOwnName(ctx, value.name)) >= MAX_TAGS) {
    throw new SetFailure('overQuota', `No more than ${MAX_TAGS} tags`);
  }
  const id = generateId('tg');
  await commit(ctx, [{ kind: 'create', type: TAG, id, value: { ...value } }]);
  const { keyword } = describe(id, value);
  return {
    id,
    keyword,
    // What was sent with space around it is kept without.
    ...(input['name'] === value.name ? {} : { name: value.name }),
  };
}

async function updateTag(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const [record] = await ctx.store.get(ctx.auth.accountId, TAG, [id]);
  if (!record) throw new SetFailure('notFound');
  const current = describe(id, record.value as unknown as TagValue);
  let next: Record<string, unknown>;
  try {
    next = applyPatch(current, patch);
  } catch (error) {
    if (error instanceof PatchError) {
      throw new SetFailure('invalidPatch', error.message);
    }
    throw error;
  }
  const fixed = ['id', 'keyword'].filter(
    (property) => next[property] !== current[property as 'id' | 'keyword'],
  );
  if (fixed.length > 0) {
    throw invalid(fixed, 'These properties are set by the server');
  }
  const value = tagValue(next);
  const changedProperties = (['name', 'color'] as const).filter(
    (property) => value[property] !== current[property],
  );
  if (changedProperties.length === 0) return null;
  if (changedProperties.includes('name')) {
    await requireOwnName(ctx, value.name, id);
  }
  await commit(ctx, [
    {
      kind: 'update',
      type: TAG,
      id,
      value: { ...value },
      expectedVersion: record.version,
      changedProperties: [...changedProperties],
    },
  ]);
  return next['name'] === value.name ? null : { name: value.name };
}

/**
 * Removes the tag. Its keyword stays on the messages that have it, where it
 * names nothing any more: taking it off each of them is the client's to do,
 * as it would any keyword.
 */
async function destroyTag(ctx: MethodContext, id: string): Promise<void> {
  const [record] = await ctx.store.get(ctx.auth.accountId, TAG, [id]);
  if (!record) throw new SetFailure('notFound');
  await commit(ctx, [
    { kind: 'destroy', type: TAG, id, expectedVersion: record.version },
  ]);
}

const tagMethods: Record<string, MethodHandler> = {
  'Tag/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, PROPERTIES);
    const { state, records, notFound } = await loadForGet(ctx, TAG, args.ids);
    return {
      accountId,
      state,
      list: records.map((record) =>
        pick(
          describe(record.id, record.value as unknown as TagValue),
          properties,
        ),
      ),
      notFound,
    };
  },

  'Tag/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, TAG, rawArgs)),
  }),

  'Tag/set': async (rawArgs, ctx) => ({
    ...(await standardSet(
      ctx,
      { type: TAG, create: createTag, update: updateTag, destroy: destroyTag },
      parseArguments(SetArgumentsSchema, rawArgs),
    )),
  }),
};

/** Tags for a JMAP server: what someone calls the keywords they put on their mail. */
export function tagsModule(): JmapModule {
  return {
    name: 'tags',
    capabilities: { [CAPABILITY_TAGS]: {} },
    accountCapabilities: () => ({
      [CAPABILITY_TAGS]: {
        maxTags: MAX_TAGS,
        maxNameLength: MAX_NAME_LENGTH,
      },
    }),
    methods: Object.fromEntries(
      Object.entries(tagMethods).map(([name, handler]) => [
        name,
        { capability: CAPABILITY_TAGS, handler },
      ]),
    ),
    pushedTypes: [TAG],
  };
}
