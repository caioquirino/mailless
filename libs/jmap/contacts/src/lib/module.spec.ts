import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from '@mailless/jmap-core';
import { createJmapEngine } from '@mailless/jmap-engine';
import { InMemoryStorageAdapter } from '@mailless/jmap-engine/memory';
import { contactsModule } from './module.js';

// What contacts do is tested through a whole server, in @mailless/jmap-server.
// Here: that they need nothing but the engine.
describe('a server with contacts and nothing else', () => {
  const AUTH = { accountId: 'acc1', username: 'ann' };
  const URL = 'https://jmap.example.com';
  const setup = async () => {
    const storage = new InMemoryStorageAdapter();
    const engine = createJmapEngine({
      storage,
      urls: { api: URL, download: URL, upload: URL, eventSource: URL },
      modules: [contactsModule()],
    });
    await engine.provisionAccount(AUTH);
    const call = async (method: string, args: Record<string, unknown> = {}) =>
      (
        await engine.handleRequest(
          {
            using: [CAPABILITY_CORE, CAPABILITY_CONTACTS],
            methodCalls: [
              [method, { accountId: AUTH.accountId, ...args }, 'c'],
            ],
          },
          AUTH,
        )
      ).methodResponses[0] as [string, Record<string, any>, string]; // eslint-disable-line @typescript-eslint/no-explicit-any
    return { engine, call, storage };
  };

  it('offers contacts in its session, and no mail', async () => {
    const { engine } = await setup();
    const session = engine.getSession(AUTH);
    expect(Object.keys(session.capabilities).sort()).toEqual(
      [CAPABILITY_CONTACTS, CAPABILITY_CORE].sort(),
    );
    expect(
      session.accounts[AUTH.accountId]?.accountCapabilities[
        CAPABILITY_CONTACTS
      ],
    ).toEqual({ maxAddressBooksPerCard: null, mayCreateAddressBook: true });
    expect(engine.pushedTypes).toEqual(['AddressBook', 'ContactCard']);
  });

  it('keeps cards, with a photo that is an uploaded file', async () => {
    const { engine, call, storage } = await setup();
    const [, books] = await call('AddressBook/get');
    expect(books['list']).toHaveLength(1);
    const { blobId } = await engine.upload(
      AUTH,
      AUTH.accountId,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'image/png',
    );
    // An upload is there for something to be made of it, and is let go when nothing is.
    const unused = await engine.upload(
      AUTH,
      AUTH.accountId,
      new Uint8Array([1]),
      'text/plain',
    );
    expect(storage.blobs.isTemporary(AUTH.accountId, blobId)).toBe(true);
    const [, made] = await call('ContactCard/set', {
      create: {
        c: {
          addressBookIds: { [books['list'][0].id]: true },
          name: { full: 'Ada Lovelace' },
          media: { m: { kind: 'photo', blobId } },
        },
      },
    });
    expect(made['notCreated']).toBeNull();
    const [, got] = await call('ContactCard/get', {
      ids: [made['created'].c.id],
      properties: ['name', 'media'],
    });
    expect(got['list'][0]).toMatchObject({
      name: { full: 'Ada Lovelace' },
      media: { m: { kind: 'photo', blobId, mediaType: 'image/png' } },
    });
    // The card relies on its photo, which stays; the upload nothing used does not.
    expect(storage.blobs.isTemporary(AUTH.accountId, blobId)).toBe(false);
    expect(storage.blobs.isTemporary(AUTH.accountId, unused.blobId)).toBe(true);
  });

  it('knows no method of mail', async () => {
    const { call } = await setup();
    expect(await call('Mailbox/get')).toEqual([
      'error',
      { type: 'unknownMethod' },
      'c',
    ]);
  });
});
