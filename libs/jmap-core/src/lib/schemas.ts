import { z } from 'zod';

export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/, {
  message: 'must be 1-255 characters from A-Z, a-z, 0-9, "-" and "_"',
});

export const UnsignedIntSchema = z
  .number()
  .int()
  .min(0)
  .max(2 ** 53 - 1);
export const IntSchema = z
  .number()
  .int()
  .min(-(2 ** 53) + 1)
  .max(2 ** 53 - 1);

export const UTCDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d*[1-9])?Z$/, {
    message: 'must be an RFC 3339 date-time in UTC, e.g. 2026-01-31T12:00:00Z',
  });

export const InvocationSchema = z.tuple([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.string(),
]);

export const RequestSchema = z.object({
  using: z.array(z.string()),
  methodCalls: z.array(InvocationSchema),
  createdIds: z.record(z.string(), z.string()).optional(),
});

export const GetArgumentsSchema = z.strictObject({
  accountId: z.string(),
  ids: z.array(z.string()).nullish(),
  properties: z.array(z.string()).nullish(),
});
export type GetArguments = z.infer<typeof GetArgumentsSchema>;

export const ChangesArgumentsSchema = z.strictObject({
  accountId: z.string(),
  sinceState: z.string(),
  maxChanges: UnsignedIntSchema.min(1).nullish(),
});
export type ChangesArguments = z.infer<typeof ChangesArgumentsSchema>;

export const SetArgumentsSchema = z.strictObject({
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  update: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  destroy: z.array(z.string()).nullish(),
});
export type SetArguments = z.infer<typeof SetArgumentsSchema>;

export const ComparatorSchema = z.looseObject({
  property: z.string(),
  isAscending: z.boolean().optional(),
  collation: z.string().optional(),
});
export type Comparator = z.infer<typeof ComparatorSchema>;

export const QueryArgumentsSchema = z.strictObject({
  accountId: z.string(),
  filter: z.record(z.string(), z.unknown()).nullish(),
  sort: z.array(ComparatorSchema).nullish(),
  position: IntSchema.optional(),
  anchor: z.string().nullish(),
  anchorOffset: IntSchema.optional(),
  limit: UnsignedIntSchema.nullish(),
  calculateTotal: z.boolean().optional(),
});
export type QueryArguments = z.infer<typeof QueryArgumentsSchema>;

export const QueryChangesArgumentsSchema = z.strictObject({
  accountId: z.string(),
  filter: z.record(z.string(), z.unknown()).nullish(),
  sort: z.array(ComparatorSchema).nullish(),
  sinceQueryState: z.string(),
  maxChanges: UnsignedIntSchema.nullish(),
  upToId: z.string().nullish(),
  calculateTotal: z.boolean().optional(),
});
export type QueryChangesArguments = z.infer<typeof QueryChangesArgumentsSchema>;
