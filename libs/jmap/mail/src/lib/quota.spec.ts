import { InMemoryMetadataStore } from '@mailless/jmap-engine/memory';
import { storedUsage } from './quota.js';

describe('storedUsage', () => {
  it('reads what an account’s mail takes up, as last counted', async () => {
    const metadata = new InMemoryMetadataStore();
    // Never counted is unknown, which is not the same as empty.
    expect(await storedUsage(metadata, 'ann')).toBeNull();

    await metadata.commit('ann', [
      { kind: 'create', type: 'Quota', id: 'mail', value: { used: 1500 } },
    ]);
    expect(await storedUsage(metadata, 'ann')).toBe(1500);
    expect(await storedUsage(metadata, 'bob')).toBeNull();

    await metadata.commit('ann', [
      { kind: 'increment', type: 'Quota', id: 'mail', deltas: { used: -2000 } },
    ]);
    // A count that has drifted below nothing is shown as nothing.
    expect(await storedUsage(metadata, 'ann')).toBe(0);
  });
});
