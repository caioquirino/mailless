import { InMemoryDirectory } from './memory-directory.js';
import { cachedReader, readerWithFallback } from './readers.js';

describe('cachedReader', () => {
  it('believes an answer for a while, and no longer', async () => {
    const directory = await InMemoryDirectory.from({
      mailboxes: { 'ann@example.com': 'ann' },
    });
    let time = 0;
    const lookups = vi.spyOn(directory, 'resolveAddress');
    const reader = cachedReader(directory, { ttlMs: 1000, now: () => time });

    expect(await reader.resolveAddress('ann@example.com')).toBe('ann');
    // However it is written, it is the same question.
    expect(await reader.resolveAddress(' ANN@example.com')).toBe('ann');
    expect(lookups).toHaveBeenCalledTimes(1);

    await directory.removeAddress('ann', 'ann@example.com');
    time = 999;
    expect(await reader.resolveAddress('ann@example.com')).toBe('ann');
    time = 1000;
    expect(await reader.resolveAddress('ann@example.com')).toBeUndefined();
    expect(lookups).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failure, and keeps no more than it is told to', async () => {
    const directory = new InMemoryDirectory();
    await directory.createAccount({ id: 'ann' });
    const lookups = vi
      .spyOn(directory, 'account')
      .mockRejectedValueOnce(new Error('unreachable'));
    const reader = cachedReader(directory, { maxEntries: 2 });

    await expect(reader.account('ann')).rejects.toThrow('unreachable');
    expect(await reader.account('ann')).toMatchObject({ id: 'ann' });
    expect(lookups).toHaveBeenCalledTimes(2);

    await reader.account('b');
    await reader.account('c');
    // The oldest answer made room, so it is asked for again.
    await reader.account('ann');
    expect(lookups).toHaveBeenCalledTimes(5);
  });
});

describe('readerWithFallback', () => {
  it('asks the second directory only about what the first does not have', async () => {
    const primary = await InMemoryDirectory.from({
      mailboxes: { 'ann@example.com': 'ann' },
      shares: { ann: { readers: ['cat'] } },
    });
    const fallback = await InMemoryDirectory.from({
      mailboxes: {
        'ann@example.com': 'old-ann',
        'old@example.com': 'ann',
        'bob@example.com': 'bob',
      },
      names: { bob: 'Bob' },
      shares: { bob: { members: ['ann', 'dan'] } },
    });
    const asked: string[] = [];
    const reader = readerWithFallback(primary, fallback, (question) =>
      asked.push(question),
    );

    expect(await reader.resolveAddress('ann@example.com')).toBe('ann');
    expect(await reader.account('ann')).toMatchObject({ id: 'ann' });
    // What the first directory says about an account it has is the whole answer.
    expect(await reader.addressesOf('ann')).toEqual(['ann@example.com']);
    expect(await reader.sharedWith('ann')).toEqual({});
    expect(await reader.sharedWith('cat')).toEqual({ ann: 'reader' });
    expect(asked).toEqual([]);

    expect(await reader.resolveAddress('bob@example.com')).toBe('bob');
    expect(await reader.account('bob')).toMatchObject({ name: 'Bob' });
    expect(await reader.addressesOf('bob')).toEqual(['bob@example.com']);
    expect(await reader.sharedWith('dan')).toEqual({ bob: 'member' });
    expect(asked).toEqual([
      'resolveAddress',
      'account',
      'addressesOf',
      'sharedWith',
    ]);

    expect(await reader.resolveAddress('x@nowhere.example')).toBeUndefined();
    expect(await reader.account('nobody')).toBeUndefined();
    expect(await reader.addressesOf('nobody')).toEqual([]);
    expect(await reader.sharedWith('nobody')).toEqual({});
    expect(asked).toHaveLength(4);
  });
});
