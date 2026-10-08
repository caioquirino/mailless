import {
  createAppPasswordStore,
  isAppPassword,
  type AppPasswordRecord,
  type AppPasswordRecords,
} from './app-passwords.js';

/** Records kept in memory, behaving as a metadata store does for these few calls. */
class InMemoryMetadataStore implements AppPasswordRecords {
  private readonly records = new Map<string, AppPasswordRecord>();
  private key = (accountId: string, type: string, id: string) =>
    JSON.stringify([accountId, type, id]);
  private writes = 0;

  /** Changes with every write, as a store's state does: for telling whether anything was written. */
  async getState(): Promise<string> {
    return String(this.writes);
  }

  async get(accountId: string, type: string, ids: readonly string[]) {
    return ids.flatMap((id) => {
      const record = this.records.get(this.key(accountId, type, id));
      return record ? [structuredClone(record)] : [];
    });
  }

  async list(accountId: string, type: string) {
    const prefix = JSON.stringify([accountId, type]).slice(0, -1);
    return [...this.records]
      .filter(([key]) => key.startsWith(`${prefix},`))
      .map(([, record]) => structuredClone(record));
  }

  async commit(
    accountId: string,
    ops: Parameters<AppPasswordRecords['commit']>[1],
  ) {
    const conflict = () =>
      Object.assign(new Error('conflict'), { name: 'ConflictError' });
    for (const op of ops) {
      const key = this.key(accountId, op.type, op.id);
      const existing = this.records.get(key);
      if (op.kind === 'create') {
        if (existing) throw conflict();
        this.records.set(key, { id: op.id, version: 1, value: op.value });
      } else if (op.kind === 'update') {
        if (existing?.version !== op.expectedVersion) throw conflict();
        this.records.set(key, {
          id: op.id,
          version: existing.version + 1,
          value: op.value,
        });
      } else {
        if (!existing) throw conflict();
        this.records.delete(key);
      }
    }
    this.writes += 1;
  }
}

function setup() {
  const metadata = new InMemoryMetadataStore();
  let time = Date.parse('2026-10-07T10:00:00Z');
  const store = createAppPasswordStore(metadata, () => new Date(time));
  return { metadata, store, advance: (ms: number) => (time += ms) };
}

describe('app passwords', () => {
  it('creates a long random secret and never stores it', async () => {
    const { store, metadata } = setup();
    const created = await store.create('me', '  Mailtemi   on phone ');
    expect(created.label).toBe('Mailtemi on phone');
    expect(created.secret).toMatch(/^mlapp-([a-z2-7]{5}-){5}[a-z2-7]{5}$/);
    expect(created.lastUsedAt).toBeNull();
    expect(isAppPassword(created.secret)).toBe(true);

    const other = await store.create('me', 'Laptop');
    expect(other.secret).not.toBe(created.secret);

    const stored = JSON.stringify(await metadata.list('me', 'AppPassword'));
    expect(stored).not.toContain(created.secret);
    expect(stored).not.toContain(created.secret.replace('mlapp-', ''));
    expect(stored).toContain('"hash"');
  });

  it('verifies the right secret, tolerating spaces and capitals', async () => {
    const { store } = setup();
    const { id, secret } = await store.create('me', 'Phone');
    expect((await store.verify('me', secret))?.id).toBe(id);
    expect(
      (
        await store.verify(
          'me',
          ` ${secret.toUpperCase().replace(/-/g, ' - ')} `,
        )
      )?.id,
    ).toBe(id);
  });

  it('rejects wrong secrets, other accounts and non-app passwords', async () => {
    const { store } = setup();
    const { secret } = await store.create('me', 'Phone');
    const wrong = `${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`;
    expect(await store.verify('me', wrong)).toBeNull();
    expect(await store.verify('someone-else', secret)).toBeNull();
    expect(await store.verify('me', 'my real password')).toBeNull();
    expect(await store.verify('me', '')).toBeNull();
    expect(await store.verify('me', 'mlapp-')).toBeNull();
    expect(isAppPassword('correct horse battery staple')).toBe(false);
  });

  it('lists passwords without their secrets, oldest first', async () => {
    const { store, advance } = setup();
    const first = await store.create('me', 'First');
    advance(1000);
    const second = await store.create('me', 'Second');
    await store.create('other', 'Not mine');

    const listed = await store.list('me');
    expect(listed.map((entry) => entry.label)).toEqual(['First', 'Second']);
    expect(listed.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(listed)).not.toContain('mlapp-');
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'label',
      'lastUsedAt',
    ]);
  });

  it('stops accepting a password once it is revoked', async () => {
    const { store } = setup();
    const kept = await store.create('me', 'Keep');
    const gone = await store.create('me', 'Lost phone');

    expect(await store.revoke('me', gone.id)).toBe(true);
    expect(await store.verify('me', gone.secret)).toBeNull();
    expect((await store.verify('me', kept.secret))?.id).toBe(kept.id);
    expect(await store.revoke('me', gone.id)).toBe(false);
    expect(await store.revoke('other', kept.id)).toBe(false);
    expect((await store.list('me')).map((entry) => entry.label)).toEqual([
      'Keep',
    ]);
  });

  it('records when a password was last used, at most once an hour', async () => {
    const { store, metadata, advance } = setup();
    const { secret } = await store.create('me', 'Phone');
    const state = () => metadata.getState();

    expect((await store.verify('me', secret))?.lastUsedAt).toBe(
      '2026-10-07T10:00:00Z',
    );
    const afterFirstUse = await state();

    advance(59 * 60 * 1000);
    for (let attempt = 0; attempt < 5; attempt++)
      await store.verify('me', secret);
    expect(await state()).toBe(afterFirstUse);

    advance(2 * 60 * 1000);
    expect((await store.verify('me', secret))?.lastUsedAt).toBe(
      '2026-10-07T11:01:00Z',
    );
    expect(await state()).not.toBe(afterFirstUse);
    expect((await store.list('me'))[0]?.lastUsedAt).toBe(
      '2026-10-07T11:01:00Z',
    );
  });

  it('stays valid when simultaneous sign-ins race to record the time', async () => {
    const { store } = setup();
    const { id, secret } = await store.create('me', 'Phone');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.verify('me', secret)),
    );
    expect(results.every((result) => result?.id === id)).toBe(true);
  });

  it('insists on a usable label', async () => {
    const { store } = setup();
    await expect(store.create('me', '   ')).rejects.toThrow(/label/);
    await expect(store.create('me', 'x'.repeat(101))).rejects.toThrow(/label/);
  });
});
