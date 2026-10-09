import { fakeBackend, testStore } from '../test-support';
import { Contacts } from './contacts';
import { People } from './people';

describe('who a message might be for', () => {
  const setup = async () => {
    const backend = await fakeBackend();
    const store = await testStore(backend);
    const send = (to: string, name: string | null = null) =>
      store.send({
        identityId: 'ann',
        to: [{ name, email: to }],
        cc: [],
        bcc: [],
        subject: 'Hello',
        html: '<p>Hello</p>',
        attachments: [],
      });
    return { store, send };
  };

  it('are the people written to before, those written to most first', async () => {
    const { store, send } = await setup();
    await send('bob@example.com', 'Bob Stone');
    await send('bella@example.org');
    await send('bella@example.org');
    await send('carol@example.com', 'Carol');

    // Found out afresh, as when the page is opened another day.
    const people = new People(store.client, new Contacts(store.client));
    await people.start(store.mailbox('sent')?.id);
    expect(people.find('b')).toEqual([
      { name: null, email: 'bella@example.org' },
      { name: 'Bob Stone', email: 'bob@example.com' },
    ]);
    // By any word of a name, or by where the address is.
    expect(people.find('sto')).toEqual([
      { name: 'Bob Stone', email: 'bob@example.com' },
    ]);
    expect(people.find('example.org').map((each) => each.email)).toEqual([
      'bella@example.org',
    ]);
    expect(people.find('')).toEqual([]);
    expect(people.find('nobody')).toEqual([]);
  });

  it('are the people in the address book too, and never those it is for already', async () => {
    const { store, send } = await setup();
    await send('bob@example.com', 'Bob');
    const books = await store.client.call(
      'AddressBook/get' as never,
      {} as never,
    );
    const bookId = (books as { list: Array<{ id: string }> }).list[0]?.id;
    await store.client.call(
      'ContactCard/set' as never,
      {
        create: {
          c: {
            addressBookIds: { [bookId as string]: true },
            name: { full: 'Bea Baker' },
            emails: { e: { address: 'bea@example.net' } },
          },
        },
      } as never,
    );
    const people = new People(store.client, new Contacts(store.client));
    await people.start(store.mailbox('sent')?.id);
    // In the address book counts for more than having been written to once.
    expect(people.find('b').map((each) => each.email)).toEqual([
      'bea@example.net',
      'bob@example.com',
    ]);
    expect(
      people
        .find('b', { without: ['BEA@example.net'] })
        .map((each) => each.email),
    ).toEqual(['bob@example.com']);
    // Someone only heard from is offered last.
    expect(
      people
        .find('b', { others: [{ name: 'Ben', email: 'ben@example.com' }] })
        .map((each) => each.email),
    ).toEqual(['bea@example.net', 'bob@example.com', 'ben@example.com']);
  });
});
