import {
  CAPABILITY_BLOB,
  CAPABILITY_MAIL,
  IdSchema,
  MethodError,
  SetFailure,
  type SetError,
} from '@mailless/jmap-core';
import { z } from 'zod';
import { readBlob } from './email.js';
import { EMAIL, MAILBOX, THREAD, type EmailRecord } from './model.js';

import {
  generateId,
  parseArguments,
  requireAccount,
  type MethodContext,
  type MethodHandler,
} from '@mailless/jmap-engine';
export { CAPABILITY_BLOB };

/*
 * Blob management (RFC 9404): making a blob out of pieces, reading a blob or
 * part of one inside a method call, and finding what refers to a blob.
 */

/** RFC 9404 §3.1: a server must accept at least this many pieces per blob. */
export const MAX_DATA_SOURCES = 64;
/** Named as in the HTTP digest registry, in lower case; the first is preferred. */
const DIGESTS: Record<string, string> = { 'sha-256': 'SHA-256', sha: 'SHA-1' };
export const DIGEST_ALGORITHMS = Object.keys(DIGESTS);
/** The data types whose objects can be found from a blob they refer to. */
export const LOOKUP_TYPES = [EMAIL, MAILBOX, THREAD];

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    return null;
  }
  try {
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function invalid(property: string, description: string): SetFailure {
  return new SetFailure('invalidProperties', description, {
    properties: [property],
  });
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The octets one piece of an upload stands for. */
async function readSource(
  ctx: MethodContext,
  source: unknown,
  path: string,
): Promise<Uint8Array> {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw invalid(path, 'Each data source must be an object');
  }
  const given = source as Record<string, unknown>;
  const kinds = ['data:asText', 'data:asBase64', 'blobId'].filter(
    (kind) => given[kind] !== undefined && given[kind] !== null,
  );
  if (kinds.length !== 1) {
    throw invalid(
      path,
      'A data source is exactly one of data:asText, data:asBase64 and blobId',
    );
  }
  const unknown = Object.keys(given).filter(
    (key) =>
      !['data:asText', 'data:asBase64', 'blobId', 'offset', 'length'].includes(
        key,
      ),
  );
  if (unknown.length > 0) throw invalid(`${path}/${unknown[0]}`, 'Unknown');

  const [kind] = kinds as [string];
  const value = given[kind];
  if (typeof value !== 'string') {
    throw invalid(`${path}/${kind}`, `${kind} must be a string`);
  }
  if (kind === 'data:asText') {
    // Half of a surrogate pair cannot be written as UTF-8, so it is not text.
    if (
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
      )
    ) {
      throw invalid(`${path}/${kind}`, 'The text is not valid Unicode');
    }
    return encoder.encode(value);
  }
  if (kind === 'data:asBase64') {
    const bytes = fromBase64(value);
    if (!bytes) throw invalid(`${path}/${kind}`, 'The data is not base64');
    return bytes;
  }

  const blobId = value.startsWith('#')
    ? ctx.createdIds.get(value.slice(1))
    : value;
  const blob =
    blobId !== undefined && IdSchema.safeParse(blobId).success
      ? await readBlob(ctx, blobId)
      : null;
  if (!blob) throw invalid(`${path}/blobId`, 'There is no blob with this id');
  for (const property of ['offset', 'length']) {
    if (
      given[property] !== undefined &&
      given[property] !== null &&
      !isCount(given[property])
    ) {
      throw invalid(`${path}/${property}`, `${property} must be a count`);
    }
  }
  const offset = (given['offset'] as number | null | undefined) ?? 0;
  const length =
    (given['length'] as number | null | undefined) ?? blob.length - offset;
  // A range that reaches past the end is an error here, not a shorter result.
  if (length < 0 || offset + length > blob.length) {
    throw invalid(
      `${path}/length`,
      'The range reaches past the end of the blob',
    );
  }
  return blob.subarray(offset, offset + length);
}

const UploadArguments = z.strictObject({
  accountId: z.string(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())),
});

const GetArguments = z.strictObject({
  accountId: z.string(),
  ids: z.array(z.string()).nullish(),
  properties: z.array(z.string()).nullish(),
  offset: z.number().int().min(0).nullish(),
  length: z.number().int().min(0).nullish(),
});

const LookupArguments = z.strictObject({
  accountId: z.string(),
  typeNames: z.array(z.string()),
  ids: z.array(z.string()),
});

export const blobMethods: Record<string, MethodHandler> = {
  'Blob/upload': async (rawArgs, ctx) => {
    const args = parseArguments(UploadArguments, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    const create = Object.entries(args.create);
    if (create.length > ctx.limits.maxObjectsInSet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInSet} blobs may be created in one call`,
      );
    }

    const created: Record<string, Record<string, unknown>> = {};
    const notCreated: Record<string, SetError> = {};
    for (const [creationId, input] of create) {
      try {
        const unknown = Object.keys(input).filter(
          (key) => key !== 'data' && key !== 'type',
        );
        if (unknown.length > 0) {
          throw new SetFailure('invalidProperties', undefined, {
            properties: unknown,
          });
        }
        const sources = input['data'];
        if (!Array.isArray(sources)) {
          throw invalid('data', 'data must be a list of data sources');
        }
        if (sources.length > MAX_DATA_SOURCES) {
          throw invalid(
            'data',
            `A blob may be made of at most ${MAX_DATA_SOURCES} pieces`,
          );
        }
        const type = input['type'] ?? null;
        if (type !== null && typeof type !== 'string') {
          throw invalid('type', 'type must be a media type or null');
        }

        const pieces: Uint8Array[] = [];
        let size = 0;
        for (const [index, source] of sources.entries()) {
          const piece = await readSource(ctx, source, `data/${index}`);
          size += piece.length;
          if (size > ctx.mail.maxSizeBlob) {
            throw new SetFailure(
              'tooLarge',
              `A blob may be at most ${ctx.mail.maxSizeBlob} octets`,
            );
          }
          pieces.push(piece);
        }
        const data = new Uint8Array(size);
        let position = 0;
        for (const piece of pieces) {
          data.set(piece, position);
          position += piece.length;
        }

        const blobId = generateId('bu');
        await ctx.blobs.put(accountId, blobId, data, { temporary: true });
        // What the upload endpoint would have answered, and the id under its usual name.
        created[creationId] = { id: blobId, accountId, blobId, type, size };
        ctx.createdIds.set(creationId, blobId);
      } catch (error) {
        if (!(error instanceof SetFailure)) throw error;
        notCreated[creationId] = error.error;
      }
    }
    return {
      accountId,
      created: Object.keys(created).length > 0 ? created : null,
      notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    };
  },

  'Blob/get': async (rawArgs, ctx) => {
    const args = parseArguments(GetArguments, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    if (!args.ids) {
      // Blobs are not listed anywhere, so there is no "all of them" to return.
      throw new MethodError('requestTooLarge', 'Blobs must be asked for by id');
    }
    const ids = [...new Set(args.ids)];
    if (ids.length > ctx.limits.maxObjectsInGet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInGet} ids may be requested at once`,
      );
    }
    const properties = [...new Set(args.properties ?? ['data', 'size'])];
    for (const property of properties) {
      const known =
        ['data', 'data:asText', 'data:asBase64', 'size'].includes(property) ||
        (property.startsWith('digest:') &&
          Object.prototype.hasOwnProperty.call(
            DIGESTS,
            property.slice('digest:'.length),
          ));
      if (!known) {
        throw new MethodError(
          'invalidArguments',
          `Unknown blob property "${property}"`,
        );
      }
    }
    const wants = (property: string) => properties.includes(property);

    const list: Record<string, unknown>[] = [];
    const notFound: string[] = [];
    for (const requested of ids) {
      // A blob made earlier in the same request can be named by its creation id.
      const id = requested.startsWith('#')
        ? (ctx.createdIds.get(requested.slice(1)) ?? requested)
        : requested;
      const blob = IdSchema.safeParse(id).success
        ? await readBlob(ctx, id)
        : null;
      if (!blob) {
        notFound.push(requested);
        continue;
      }
      const offset = Math.min(args.offset ?? 0, blob.length);
      const end =
        args.length === null || args.length === undefined
          ? blob.length
          : Math.min(offset + args.length, blob.length);
      const range = blob.subarray(offset, end);
      // Truncated means the range asked for was not all there.
      const isTruncated =
        (args.offset ?? 0) > blob.length ||
        (args.length !== null &&
          args.length !== undefined &&
          (args.offset ?? 0) + args.length > blob.length);

      let text: string | null = null;
      if (wants('data') || wants('data:asText')) {
        try {
          text = strictUtf8.decode(range);
        } catch {
          // Not UTF-8, or cut in the middle of a character.
        }
      }
      const result: Record<string, unknown> = { id };
      if (wants('data:asText') || (wants('data') && text !== null)) {
        result['data:asText'] = text;
      }
      if (wants('data:asBase64') || (wants('data') && text === null)) {
        result['data:asBase64'] = toBase64(range);
      }
      if ((wants('data') || wants('data:asText')) && text === null) {
        result['isEncodingProblem'] = true;
      }
      if (isTruncated) result['isTruncated'] = true;
      for (const property of properties) {
        if (!property.startsWith('digest:')) continue;
        const algorithm = DIGESTS[property.slice('digest:'.length)] as string;
        result[property] = toBase64(
          new Uint8Array(
            await crypto.subtle.digest(algorithm, new Uint8Array(range)),
          ),
        );
      }
      if (wants('size')) result['size'] = blob.length;
      list.push(result);
    }
    return { accountId, list, notFound };
  },

  'Blob/lookup': async (rawArgs, ctx) => {
    const args = parseArguments(LookupArguments, rawArgs);
    const accountId = requireAccount(ctx, args.accountId);
    for (const typeName of args.typeNames) {
      if (
        !LOOKUP_TYPES.includes(typeName) ||
        !ctx.using.includes(CAPABILITY_MAIL)
      ) {
        throw new MethodError(
          'unknownDataType',
          `"${typeName}" is not a type that blobs can be looked up in`,
        );
      }
    }
    const ids = [...new Set(args.ids)];
    if (ids.length > ctx.limits.maxObjectsInGet) {
      throw new MethodError(
        'requestTooLarge',
        `At most ${ctx.limits.maxObjectsInGet} ids may be looked up at once`,
      );
    }

    // An email refers to its message, and through it to each part of the message.
    const emails =
      ids.length === 0 || args.typeNames.length === 0
        ? []
        : ((await ctx.store.list(
            accountId,
            EMAIL,
          )) as unknown as EmailRecord[]);
    return {
      accountId,
      list: ids.map((id) => {
        const referring = emails.filter(
          (email) =>
            email.value.blobId === id ||
            id.startsWith(`${email.value.blobId}-`),
        );
        const found: Record<string, string[]> = {
          [EMAIL]: referring.map((email) => email.id),
          [THREAD]: [
            ...new Set(referring.map((email) => email.value.threadId)),
          ],
          [MAILBOX]: [
            ...new Set(
              referring.flatMap((email) => Object.keys(email.value.mailboxIds)),
            ),
          ],
        };
        // A blob nobody refers to, or that is not there at all, looks the same.
        return {
          id,
          matchedIds: Object.fromEntries(
            args.typeNames.map((typeName) => [typeName, found[typeName] ?? []]),
          ),
        };
      }),
    };
  },
};
