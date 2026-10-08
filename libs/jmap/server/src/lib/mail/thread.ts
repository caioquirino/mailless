import { GetArgumentsSchema } from '@mailless/jmap-core';
import {
  parseArguments,
  requireAccount,
  type MethodHandler,
} from '../context.js';
import { standardChanges, toChangesResponse } from '../standard/changes.js';
import { loadForGet, pick, selectProperties } from '../standard/get.js';
import { THREAD, type ThreadRecord } from './model.js';

export const threadMethods: Record<string, MethodHandler> = {
  'Thread/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArgumentsSchema, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const properties = selectProperties(args.properties, ['id', 'emailIds']);
    const { state, records, notFound } = await loadForGet(
      ctx,
      THREAD,
      args.ids,
    );
    return {
      accountId,
      state,
      list: (records as unknown as ThreadRecord[]).map((record) =>
        pick({ id: record.id, emailIds: record.value.emailIds }, properties),
      ),
      notFound,
    };
  },

  'Thread/changes': async (rawArgs, ctx) => ({
    ...toChangesResponse(await standardChanges(ctx, THREAD, rawArgs)),
  }),
};
