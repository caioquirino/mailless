import { createClient, createConfig } from './generated/client/index.js';

export * from './generated/index.js';
export type { Client } from './generated/client/index.js';

export interface AdminClientOptions {
  /** Where the API is, such as `https://mail.example.com/admin/api`. */
  baseUrl: string;
  /** The signed-in user's access token, asked for on every call so that a renewed one is used. */
  token(): string | undefined | Promise<string | undefined>;
  /** In place of the global `fetch`, for tests and for hosts that have their own. */
  fetch?: typeof fetch;
}

/**
 * A client for one API and one signed-in user. Pass it to an operation as
 * `client`: `getMe({ client })`.
 */
export function createAdminClient(options: AdminClientOptions) {
  return createClient(
    createConfig({
      baseUrl: options.baseUrl,
      auth: () => options.token(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  );
}
