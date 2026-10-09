import type {
  AddedItem,
  ChangesResponse,
  GetResponse,
  Id,
  QueryChangesResponse,
  QueryResponse,
  ResultReference,
} from '@mailless/jmap-core';
import { CAPABILITY_CORE } from '@mailless/jmap-core';
import type {
  Batch,
  BatchOptions,
  BatchResult,
  Call,
  JmapClient,
} from './client.js';
import { JmapMethodError } from './errors.js';
import type { Comparator } from './methods.js';

/*
 * A local copy of what is on the server, kept in step with it. Records are
 * held by id (`ObjectCache`), lists of ids by what was asked for
 * (`QueryView`), and `sync` brings every one of them up to date in as few
 * requests as it takes: the server is asked what changed since last time
 * (RFC 8620 §5.2 and §5.6), not for everything again.
 */

/** Something `sync` can bring up to date. */
export interface Synced {
  /**
   * Adds what it has to ask to a batch, and returns what to do with the
   * answer: that says whether there is more to ask. Null when there is
   * nothing to ask yet.
   */
  ask(batch: Batch): ((result: BatchResult) => boolean) | null;
}

/** The most rounds one `sync` asks before leaving the rest for the next. */
const MAX_ROUNDS = 8;

/** The most calls one part adds to a batch. */
const MOST_CALLS = 3;

/**
 * Brings every part up to date. One request when little changed; more when
 * the server has more changes than it tells at once, or when there are more
 * parts than the server takes calls in one request.
 */
export async function sync(
  client: JmapClient,
  parts: readonly Synced[],
  options: BatchOptions = {},
): Promise<void> {
  if (parts.length === 0) return;
  const core = (await client.session()).capabilities[CAPABILITY_CORE] as
    { maxCallsInRequest?: number } | undefined;
  const limit = Math.max(core?.maxCallsInRequest ?? 16, MOST_CALLS);

  let pending = [...parts];
  for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
    const more: Synced[] = [];
    let batch = client.batch(options);
    let asked: Array<[Synced, (result: BatchResult) => boolean]> = [];
    const send = async () => {
      if (asked.length === 0) return;
      const result = await batch.send();
      for (const [part, answer] of asked) {
        if (answer(result)) more.push(part);
      }
      batch = client.batch(options);
      asked = [];
    };
    for (const part of pending) {
      if (batch.size + MOST_CALLS > limit) await send();
      const answer = part.ask(batch);
      if (answer) asked.push([part, answer]);
    }
    await send();
    pending = more;
  }
}

class Listeners {
  private readonly listeners = new Set<() => void>();
  /** Goes up with every change: what a view compares to know it has to draw again. */
  version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  changed(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Whether a call failed because the server no longer knows what changed since the state it was given. */
function cannotCalculate(error: unknown): boolean {
  return (
    error instanceof JmapMethodError && error.type === 'cannotCalculateChanges'
  );
}

function withAccount(
  accountId: Id | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return accountId === undefined ? args : { accountId, ...args };
}

export interface ObjectCacheOptions {
  /** The data type: `Mailbox`, `Email`. */
  type: string;
  /** The properties to hold of each record. All of them when left out. */
  properties?: string[];
  /**
   * The properties that can change after a record is made, which are the
   * ones asked for again when it does. Defaults to `properties`. For Email:
   * `mailboxIds` and `keywords`.
   */
  changing?: string[];
  /**
   * Holds every record of the type, which suits the small ones: mailboxes,
   * identities. Otherwise only the records asked for with `load`.
   */
  everything?: boolean;
  /** The account, when not the user's own for this kind of data. */
  accountId?: Id;
  /** How many changes to take from the server at once. */
  maxChanges?: number;
}

/** Records of one type, by id. */
export class ObjectCache<T extends { id: Id }> implements Synced {
  private readonly records = new Map<Id, T>();
  private readonly listeners = new Listeners();
  private state: string | null = null;
  /** The server could not say what changed: everything held is asked for again. */
  private stale = false;
  private complete = false;
  private snapshot: { version: number; values: T[] } | undefined;

  constructor(
    private readonly client: JmapClient,
    private readonly options: ObjectCacheOptions,
  ) {}

  readonly subscribe = this.listeners.subscribe;

  /** Goes up with every change to what is held. */
  get version(): number {
    return this.listeners.version;
  }

  /** Whether a cache of everything has been filled. */
  get isComplete(): boolean {
    return this.complete;
  }

  get(id: Id): T | undefined {
    return this.records.get(id);
  }

  /** Every record held. The same list until something changes. */
  values(): readonly T[] {
    if (this.snapshot?.version !== this.version) {
      this.snapshot = {
        version: this.version,
        values: [...this.records.values()],
      };
    }
    return this.snapshot.values;
  }

  private args(args: Record<string, unknown>): Record<string, unknown> {
    return withAccount(this.options.accountId, args);
  }

  private get batchOptions(): BatchOptions {
    return this.options.accountId ? { accountId: this.options.accountId } : {};
  }

  private merge(list: readonly T[]): void {
    for (const record of list) {
      const held = this.records.get(record.id);
      this.records.set(record.id, held ? { ...held, ...record } : record);
    }
  }

  /**
   * Makes sure records are held: asks the server for those that are not.
   * Without ids, for a cache of everything, fills it.
   */
  async load(ids?: readonly Id[]): Promise<void> {
    if (ids === undefined) {
      if (!this.options.everything) {
        throw new Error('Name the records to load: this cache holds some');
      }
      if (this.complete) return;
    }
    const missing = ids?.filter((id) => !this.records.has(id));
    if (missing?.length === 0) return;
    const response = (await this.client.call(
      `${this.options.type}/get` as string,
      this.args({
        ids: missing ? [...new Set(missing)] : null,
        properties: this.options.properties ?? null,
      }),
    )) as unknown as GetResponse<T>;
    this.merge(response.list);
    // Only the first answer sets where changes are asked from: what was
    // loaded later is at least as new, and hearing of a change twice is harmless.
    this.state ??= response.state;
    if (ids === undefined) this.complete = true;
    this.listeners.changed();
  }

  /**
   * Asks for records as part of a batch, where the ids may be what an
   * earlier call of it finds: a list and the records in it, in one request.
   * Returns the call, for later ones to refer to, and what to do with the
   * answer, which keeps the records and gives them back. Null for the ids
   * asks for every record there is.
   */
  loadIn(
    batch: Batch,
    ids: readonly Id[] | ResultReference | null,
  ): { call: Call; done(result: BatchResult): T[] } {
    const call = batch.call(
      `${this.options.type}/get` as string,
      this.args({
        ...(ids === null
          ? { ids: null }
          : 'resultOf' in ids
            ? { '#ids': ids }
            : { ids: [...ids] }),
        properties: this.options.properties ?? null,
      }),
    );
    return {
      call,
      done: (result) => {
        const response = result.get(call) as unknown as GetResponse<T>;
        this.merge(response.list);
        this.state ??= response.state;
        if (ids === null) this.complete = true;
        if (response.list.length > 0 || ids === null) this.listeners.changed();
        return response.list;
      },
    };
  }

  /**
   * Asks for more of some records than the cache holds of every one, such
   * as the body of the message being read, and keeps it with them.
   */
  async fetch(ids: readonly Id[], args: Record<string, unknown>): Promise<T[]> {
    const response = (await this.client.call(
      `${this.options.type}/get` as string,
      this.args({ ...args, ids: [...ids] }),
    )) as unknown as GetResponse<T>;
    this.merge(response.list);
    this.state ??= response.state;
    this.listeners.changed();
    return response.list;
  }

  /**
   * Changes a record here before the server has been told, so that what is
   * shown follows at once. Returns how to take it back, for when the server
   * refuses. The next `sync` puts whatever the server says in its place.
   */
  patch(id: Id, changes: Partial<T>): () => void {
    const before = this.records.get(id);
    if (!before) return () => undefined;
    this.records.set(id, { ...before, ...changes });
    this.listeners.changed();
    return () => {
      if (!this.records.has(id)) return;
      this.records.set(id, before);
      this.listeners.changed();
    };
  }

  /** Lets go of a record here, as `patch` changes one. */
  remove(id: Id): () => void {
    const before = this.records.get(id);
    if (!before) return () => undefined;
    this.records.delete(id);
    this.listeners.changed();
    return () => {
      this.records.set(id, before);
      this.listeners.changed();
    };
  }

  /** Brings what is held up to date. `sync` does the same for several at once. */
  sync(): Promise<void> {
    return sync(this.client, [this], this.batchOptions);
  }

  ask(batch: Batch): ((result: BatchResult) => boolean) | null {
    if (this.state === null) return null;
    const { type, properties, everything } = this.options;
    const get = `${type}/get` as string;

    if (this.stale) {
      const held = [...this.records.keys()];
      const all = batch.call(
        get,
        this.args({
          ids: everything ? null : held,
          properties: properties ?? null,
        }),
      );
      return (result) => {
        const response = result.get(all) as unknown as GetResponse<T>;
        if (everything) this.records.clear();
        for (const id of response.notFound) this.records.delete(id);
        this.merge(response.list);
        this.state = response.state;
        this.stale = false;
        this.listeners.changed();
        return false;
      };
    }

    const changes = batch.call(
      `${type}/changes` as string,
      this.args({
        sinceState: this.state,
        maxChanges: this.options.maxChanges ?? 200,
      }),
    );
    const updated = batch.call(
      get,
      this.args({
        '#ids': changes.ref('/updated'),
        properties: this.options.changing
          ? ['id', ...this.options.changing]
          : (properties ?? null),
      }),
    );
    const created = everything
      ? batch.call(
          get,
          this.args({
            '#ids': changes.ref('/created'),
            properties: properties ?? null,
          }),
        )
      : null;

    return (result) => {
      let changed: ChangesResponse;
      try {
        changed = result.get(changes) as unknown as ChangesResponse;
      } catch (error) {
        if (!cannotCalculate(error)) throw error;
        this.stale = true;
        return true;
      }
      if (changed.newState === this.state) return false;

      let touched = false;
      for (const id of changed.destroyed) {
        touched = this.records.delete(id) || touched;
      }
      const fresh = [
        // Of what changed, only what is held is kept: the rest was never asked for.
        ...(result.get(updated) as unknown as GetResponse<T>).list.filter(
          (record) => everything || this.records.has(record.id),
        ),
        ...(created
          ? (result.get(created) as unknown as GetResponse<T>).list
          : []),
      ];
      if (this.options.properties || this.options.changing) this.merge(fresh);
      else {
        // Asked for whole, a record is what the server says it is now: a
        // property it no longer has is not one to go on holding.
        for (const record of fresh) this.records.set(record.id, record);
      }
      this.state = changed.newState;
      if (touched || fresh.length > 0) this.listeners.changed();
      return changed.hasMoreChanges;
    };
  }
}

export interface QueryViewOptions<Condition = Record<string, unknown>> {
  /** The data type: `Email`. */
  type: string;
  filter?: Condition | Record<string, unknown> | null;
  sort?: Comparator[] | null;
  /** How many ids to ask for at a time. */
  pageSize?: number;
  /** What else the query takes, such as `collapseThreads` for Email. */
  arguments?: Record<string, unknown>;
  /** The account, when not the user's own for this kind of data. */
  accountId?: Id;
}

/** The ids a query finds, in order, from the top down to as far as was asked. */
export class QueryView implements Synced {
  private list: Id[] = [];
  private readonly listeners = new Listeners();
  private queryState: string | null = null;
  private known: number | null = null;
  private more = false;
  /** The server could not say what changed: the list is asked for again from the top. */
  private stale = false;
  /** How many more than are held to ask for when the list is asked for again. */
  private grow = 0;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly client: JmapClient,
    private readonly options: QueryViewOptions,
  ) {}

  readonly subscribe = this.listeners.subscribe;

  /** Goes up with every change to the list. */
  get version(): number {
    return this.listeners.version;
  }

  /** The ids held. The same list until something changes. */
  get ids(): readonly Id[] {
    return this.list;
  }

  /** How many the query finds in all, once the server has said. */
  get total(): number | null {
    return this.known;
  }

  /** Whether the first page has arrived. */
  get isLoaded(): boolean {
    return this.queryState !== null;
  }

  /** Whether the query finds more than is held. */
  get hasMore(): boolean {
    return this.more;
  }

  private get pageSize(): number {
    return this.options.pageSize ?? 50;
  }

  private args(args: Record<string, unknown>): Record<string, unknown> {
    return withAccount(this.options.accountId, {
      filter: this.options.filter ?? null,
      sort: this.options.sort ?? null,
      ...this.options.arguments,
      calculateTotal: true,
      ...args,
    });
  }

  private get batchOptions(): BatchOptions {
    return this.options.accountId ? { accountId: this.options.accountId } : {};
  }

  private adopt(response: QueryResponse, limit: number): void {
    this.list = [...response.ids];
    this.queryState = response.canCalculateChanges ? response.queryState : '';
    this.setTotal(response.total, response.ids.length === limit);
    this.stale = !response.canCalculateChanges;
    this.listeners.changed();
  }

  private setTotal(total: number | undefined, filledPage: boolean): void {
    this.known = total ?? null;
    this.more = total === undefined ? filledPage : this.list.length < total;
  }

  /**
   * Asks for a page as part of a batch: the top of the list, or with `more`
   * the next page down. Later calls of the batch can ask for what it finds.
   * Null when there is nothing to ask for.
   */
  loadIn(
    batch: Batch,
    options: { more?: boolean } = {},
  ): { call: Call; done(result: BatchResult): void } | null {
    const more = options.more === true && this.isLoaded;
    if (more ? !this.more : this.isLoaded) return null;
    const limit = this.pageSize;
    const call = batch.call(
      `${this.options.type}/query` as string,
      this.args({ position: more ? this.list.length : 0, limit }),
    );
    return {
      call,
      done: (result) => {
        const response = result.get(call) as unknown as QueryResponse;
        if (!more) return this.adopt(response, limit);
        if (
          !response.canCalculateChanges ||
          response.queryState !== this.queryState
        ) {
          // The list moved while this page was being asked for: what is held
          // and what arrived may not fit together. The next sync asks again.
          this.stale = true;
          this.grow = limit;
          return;
        }
        const held = new Set(this.list);
        this.list = [
          ...this.list,
          ...response.ids.filter((id) => !held.has(id)),
        ];
        this.setTotal(response.total, response.ids.length === limit);
        this.listeners.changed();
      },
    };
  }

  private async page(more: boolean): Promise<void> {
    const batch = this.client.batch(this.batchOptions);
    const asked = this.loadIn(batch, { more });
    if (!asked) return;
    asked.done(await batch.send());
    if (this.stale) await this.sync();
  }

  /** Asks for the top of the list, once. */
  load(): Promise<void> {
    this.loading ??= this.page(false).finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** Asks for the next page down. */
  loadMore(): Promise<void> {
    this.loading ??= this.page(true).finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /**
   * Takes ids out of the list here before the server has said so, so that
   * what is shown follows at once. The next `sync` puts whatever the server
   * says in its place.
   */
  drop(ids: readonly Id[]): void {
    const gone = new Set(ids);
    const list = this.list.filter((id) => !gone.has(id));
    if (list.length === this.list.length) return;
    if (this.known !== null) this.known -= this.list.length - list.length;
    this.list = list;
    this.listeners.changed();
  }

  /** Brings the list up to date. `sync` does the same for several at once. */
  sync(): Promise<void> {
    return sync(this.client, [this], this.batchOptions);
  }

  ask(batch: Batch): ((result: BatchResult) => boolean) | null {
    if (this.queryState === null) return null;
    const { type } = this.options;

    if (this.stale) {
      const limit = Math.max(this.list.length + this.grow, this.pageSize);
      this.grow = 0;
      const query = batch.call(
        `${type}/query` as string,
        this.args({ position: 0, limit }),
      );
      return (result) => {
        const response = result.get(query) as unknown as QueryResponse;
        this.adopt(response, limit);
        // A server that cannot tell changes is asked from the top each time.
        return false;
      };
    }

    const last = this.list.at(-1);
    const changes = batch.call(
      `${type}/queryChanges` as string,
      this.args({
        sinceQueryState: this.queryState,
        // Below the last id held nothing is held, so nothing there matters.
        ...(this.more && last !== undefined ? { upToId: last } : {}),
      }),
    );
    return (result) => {
      let changed: QueryChangesResponse;
      try {
        changed = result.get(changes) as unknown as QueryChangesResponse;
      } catch (error) {
        if (!cannotCalculate(error)) throw error;
        this.stale = true;
        return true;
      }
      const total = changed.total ?? this.known ?? undefined;
      if (
        changed.newQueryState === this.queryState &&
        total === (this.known ?? undefined)
      ) {
        return false;
      }
      this.list = applyQueryChanges(this.list, changed.removed, changed.added);
      this.queryState = changed.newQueryState;
      this.known = total ?? null;
      this.more = total === undefined ? this.more : this.list.length < total;
      this.listeners.changed();
      return false;
    };
  }
}

/** A list of ids after what a `/queryChanges` says happened to it (RFC 8620 §5.6). */
export function applyQueryChanges(
  ids: readonly Id[],
  removed: readonly Id[],
  added: readonly AddedItem[],
): Id[] {
  const gone = new Set([...removed, ...added.map((item) => item.id)]);
  const list = ids.filter((id) => !gone.has(id));
  for (const item of [...added].sort((a, b) => a.index - b.index)) {
    // Past the end of what is held is somewhere this list does not reach.
    if (item.index <= list.length) list.splice(item.index, 0, item.id);
  }
  return list;
}
