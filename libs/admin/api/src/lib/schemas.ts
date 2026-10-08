import { z } from '@hono/zod-openapi';

/*
 * What goes over the wire. Each schema is named, so the OpenAPI document and
 * the client generated from it have a type of the same name.
 */

export const AccountIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,64}$/)
  .openapi({
    description: 'Small letters, digits, "-" and "_". Never changes.',
    example: 'ann',
  });

export const AddressSchema = z.string().min(3).max(320).openapi({
  description: 'name@domain, or *@domain for a whole domain.',
  example: 'ann@example.com',
});

export const StatusSchema = z
  .enum(['active', 'disabled', 'deleting'])
  .openapi('AccountStatus');

export const AccessSchema = z.enum(['member', 'reader']).openapi('ShareAccess');

/** At least 1 MiB: less would not hold a message with a picture. */
const QuotaSchema = z
  .number()
  .int()
  .min(1_048_576)
  .max(Number.MAX_SAFE_INTEGER);

export const AccountSchema = z
  .object({
    id: AccountIdSchema,
    name: z.string().nullable(),
    status: StatusSchema,
    quotaOctets: QuotaSchema.nullable().openapi({
      description:
        'The limit this account was given, in bytes. Null when it has none of its own and gets what every account gets.',
    }),
    createdAt: z.string(),
  })
  .openapi('Account');

export const MailUsageSchema = z
  .object({
    usedOctets: z.number().int().nonnegative().nullable().openapi({
      description:
        'How much the mailbox holds, in bytes. Null when it has not been counted yet, which it is the first time the account is used.',
    }),
    limitOctets: z.number().int().positive().nullable().openapi({
      description:
        "How much it may hold, in bytes: the account's own limit, or else the one every account gets. Null when there is no limit.",
    }),
  })
  .openapi('MailUsage');

/** An account as a list shows it. */
export const AccountSummarySchema = AccountSchema.extend({
  usage: MailUsageSchema,
}).openapi('AccountSummary');

export const AccountDetailSchema = AccountSchema.extend({
  addresses: z.array(AddressSchema),
  shares: z.record(z.string(), AccessSchema).openapi({
    description: 'Who else may use the account, by user.',
  }),
  sharedWith: z.record(z.string(), AccessSchema).openapi({
    description: 'The other accounts this user may use, by account.',
  }),
  canSignIn: z.boolean().openapi({
    description: 'Whether the identity provider has an enabled user for it.',
  }),
  isAdmin: z.boolean(),
  usage: MailUsageSchema,
}).openapi('AccountDetail');

export const CapabilitiesSchema = z
  .object({
    changeOwnPassword: z.boolean(),
    manageOwnPasskeys: z.boolean(),
    removePasskeysOfOthers: z.boolean(),
  })
  .openapi('Capabilities');

export const MeSchema = z
  .object({
    username: z.string(),
    isAdmin: z.boolean(),
    // A union, not `.nullable()`: that would make every Account in the document nullable.
    account: z.union([AccountSchema, z.null()]).openapi({
      description: 'Null for a user who has no mailbox.',
    }),
    addresses: z.array(AddressSchema),
    usage: z.union([MailUsageSchema, z.null()]).openapi({
      description: 'Null for a user who has no mailbox.',
    }),
    capabilities: CapabilitiesSchema,
    passkeyEnrolmentUrl: z.string().nullable().openapi({
      description:
        'The page of the identity provider where a passkey is added, when it has one.',
    }),
  })
  .openapi('Me');

export const PasskeySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    createdAt: z.string().nullable(),
  })
  .openapi('Passkey');

export const AppPasswordSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi('AppPassword');

export const NewAppPasswordSchema = AppPasswordSchema.extend({
  secret: z.string().openapi({
    description: 'Shown this once. It cannot be read again.',
  }),
}).openapi('NewAppPassword');

const PasswordSchema = z.string().min(1).max(256);

export const ChangePasswordSchema = z
  .object({ currentPassword: PasswordSchema, newPassword: PasswordSchema })
  .openapi('ChangePassword');

export const SetPasswordSchema = z
  .object({
    password: PasswordSchema,
    temporary: z.boolean().default(true).openapi({
      description:
        'A temporary password must be replaced by the user when they first sign in.',
    }),
  })
  .openapi('SetPassword');

export const CreateAccountSchema = z
  .object({
    id: AccountIdSchema,
    name: z.string().min(1).max(200).nullable().optional(),
  })
  .openapi('CreateAccount');

export const UpdateAccountSchema = z
  .object({
    name: z.string().min(1).max(200).nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
    quotaOctets: QuotaSchema.nullable().optional().openapi({
      description:
        'A limit of its own for this account, in bytes, or null to go back to what every account gets.',
    }),
  })
  .openapi('UpdateAccount');

export const SetShareSchema = z
  .object({ access: AccessSchema })
  .openapi('SetShare');

export const NewLabelSchema = z
  .object({ label: z.string().min(1).max(100) })
  .openapi('NewLabel');

export const ErrorSchema = z
  .object({
    error: z.string().openapi({
      description:
        'What went wrong, as a word a program can act on: invalid, unauthorized, forbidden, notFound, exists, addressTaken, invalidPassword, notAuthorized, rateLimited, unsupported.',
    }),
    message: z.string(),
  })
  .openapi('Error');
