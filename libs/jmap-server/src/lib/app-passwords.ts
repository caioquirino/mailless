import { generateId, toUtcDate } from './context.js';
import { ConflictError, type MetadataStore } from './storage.js';

/** The data type app passwords are stored under. No JMAP method exposes it. */
const TYPE = 'AppPassword';
const PREFIX = 'mlapp-';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** 30 characters of base32 is 150 bits: far beyond guessing, so a fast hash is enough. */
const SECRET_LENGTH = 30;
const MAX_LABEL_LENGTH = 100;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

type AppPasswordValue = {
  label: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export interface AppPassword {
  id: string;
  label: string;
  createdAt: string;
  /** When it last signed in, to the hour. Null if never used. */
  lastUsedAt: string | null;
}

export interface AppPasswordStore {
  /** Makes a new password. The secret is returned once and cannot be recovered later. */
  create(
    accountId: string,
    label: string,
  ): Promise<AppPassword & { secret: string }>;
  list(accountId: string): Promise<AppPassword[]>;
  /** Returns false when there is no such password. */
  revoke(accountId: string, id: string): Promise<boolean>;
  /** The matching password, or null. Never throws for a wrong or malformed secret. */
  verify(accountId: string, secret: string): Promise<AppPassword | null>;
}

function normalise(secret: string): string {
  // Clients and people add spaces and capitals; neither is part of the secret.
  return secret.replace(/\s+/g, '').toLowerCase();
}

/** Whether a password has the shape of an app password, so callers can route it without a lookup. */
export function isAppPassword(password: string): boolean {
  return normalise(password).startsWith(PREFIX);
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalise(secret)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function generateSecret(): string {
  // 256 is a multiple of 32, so taking the low five bits of each byte is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH));
  const characters = [...bytes].map((byte) => ALPHABET[byte & 31]);
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += 5) {
    groups.push(characters.slice(index, index + 5).join(''));
  }
  return PREFIX + groups.join('-');
}

function toPublic(id: string, value: AppPasswordValue): AppPassword {
  return {
    id,
    label: value.label,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt,
  };
}

/**
 * Per-client passwords kept in the metadata store. Only a hash is stored, so
 * a leak of the store does not reveal them.
 */
export function createAppPasswordStore(
  metadata: MetadataStore,
  now: () => Date = () => new Date(),
): AppPasswordStore {
  return {
    async create(accountId, label) {
      const cleanLabel = label.trim().replace(/\s+/g, ' ');
      if (!cleanLabel || cleanLabel.length > MAX_LABEL_LENGTH) {
        throw new Error(
          `A label of 1 to ${MAX_LABEL_LENGTH} characters is needed, to tell passwords apart later.`,
        );
      }
      const id = generateId('ap');
      const secret = generateSecret();
      const value: AppPasswordValue = {
        label: cleanLabel,
        hash: await hashSecret(secret),
        createdAt: toUtcDate(now()),
        lastUsedAt: null,
      };
      await metadata.commit(accountId, [
        { kind: 'create', type: TYPE, id, value },
      ]);
      return { ...toPublic(id, value), secret };
    },

    async list(accountId) {
      const records = await metadata.list(accountId, TYPE);
      return records
        .map((record) => toPublic(record.id, record.value as AppPasswordValue))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async revoke(accountId, id) {
      const [record] = await metadata.get(accountId, TYPE, [id]);
      if (!record) return false;
      try {
        await metadata.commit(accountId, [{ kind: 'destroy', type: TYPE, id }]);
      } catch (error) {
        // Someone else removed it in the meantime, which is the outcome asked for.
        if (!(error instanceof ConflictError)) throw error;
      }
      return true;
    },

    async verify(accountId, secret) {
      if (!isAppPassword(secret)) return null;
      const hash = await hashSecret(secret);
      const records = await metadata.list(accountId, TYPE);
      // Compare against every stored hash so the time taken does not depend on which one matched.
      let match: (typeof records)[number] | undefined;
      for (const record of records) {
        if (timingSafeEqual((record.value as AppPasswordValue).hash, hash)) {
          match = record;
        }
      }
      if (!match) return null;

      const value = match.value as AppPasswordValue;
      const moment = now();
      const lastUsed =
        value.lastUsedAt === null ? 0 : Date.parse(value.lastUsedAt);
      if (moment.getTime() - lastUsed >= LAST_USED_RESOLUTION_MS) {
        // Recorded at most hourly: a busy client must not cause a write per request.
        const updated = { ...value, lastUsedAt: toUtcDate(moment) };
        try {
          await metadata.commit(accountId, [
            {
              kind: 'update',
              type: TYPE,
              id: match.id,
              value: updated,
              expectedVersion: match.version,
              changedProperties: ['lastUsedAt'],
            },
          ]);
          return toPublic(match.id, updated);
        } catch (error) {
          // Losing a race to record the time is harmless; the password is still valid.
          if (!(error instanceof ConflictError)) throw error;
        }
      }
      return toPublic(match.id, value);
    },
  };
}
