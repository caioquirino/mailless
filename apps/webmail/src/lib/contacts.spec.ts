import {
  cardAbout,
  cardBirthday,
  cardName,
  cardOf,
  formatBirthday,
  formOf,
  formProblem,
  grouped,
  searchCards,
  type Card,
  type CardForm,
} from './contacts';

const form = (changes: Partial<CardForm> = {}): CardForm => ({
  name: 'Marta Lindqvist',
  company: 'Northwind Legal',
  title: 'Partner',
  emails: [
    { kind: 'work', value: 'marta@northwind.example' },
    { kind: 'home', value: ' marta@post.example ' },
    { kind: 'other', value: '' },
  ],
  phones: [{ kind: 'mobile', value: '+46 70 555 01 87' }],
  address: 'Strandvägen 12, Stockholm',
  birthday: '1980-03-14',
  notes: 'Prefers a call.',
  bookId: 'book1',
  photo: 'blob1',
  ...changes,
});

describe('a contact', () => {
  it('is written as a card mail programs agree on, and read back the same', () => {
    const card = cardOf(form());
    expect(card).toMatchObject({
      addressBookIds: { book1: true },
      name: { full: 'Marta Lindqvist' },
      organizations: { '1': { name: 'Northwind Legal' } },
      titles: { '1': { name: 'Partner' } },
      emails: {
        '1': { address: 'marta@northwind.example', contexts: { work: true } },
        '2': { address: 'marta@post.example', contexts: { private: true } },
      },
      phones: {
        '1': { number: '+46 70 555 01 87', features: { mobile: true } },
      },
      anniversaries: {
        '1': { kind: 'birth', date: { year: 1980, month: 3, day: 14 } },
      },
      media: { '1': { kind: 'photo', blobId: 'blob1' } },
    });
    // The row left empty is not an address of theirs.
    expect(Object.keys(card['emails'] as object)).toHaveLength(2);

    const back = formOf({ id: 'c1', ...card } as unknown as Card, 'other');
    expect(back).toEqual(
      form({
        emails: [
          { kind: 'work', value: 'marta@northwind.example' },
          { kind: 'home', value: 'marta@post.example' },
        ],
      }),
    );
  });

  it('loses what is emptied, and nothing else', () => {
    const card = cardOf(
      form({ company: ' ', title: '', birthday: '', notes: '', photo: null }),
    );
    expect(card).toMatchObject({
      organizations: null,
      titles: null,
      anniversaries: null,
      notes: null,
      media: null,
    });
    expect(card['name']).toEqual({ full: 'Marta Lindqvist' });
  });

  it('is called by its name, or failing that by where it is written to', () => {
    const marta = { id: '1', ...cardOf(form()) } as unknown as Card;
    expect(cardName(marta)).toBe('Marta Lindqvist');
    expect(cardAbout(marta)).toBe('Partner · Northwind Legal');
    const bare = {
      id: '2',
      emails: { '1': { address: 'x@example.com' } },
    } as Card;
    expect(cardName(bare)).toBe('x@example.com');
    expect(cardAbout(bare)).toBe('');
    expect(cardName({ id: '3' })).toBe('(no name)');
  });

  it('has a birthday with or without the year', () => {
    const marta = { id: '1', ...cardOf(form()) } as unknown as Card;
    expect(cardBirthday(marta)).toBe('1980-03-14');
    expect(formatBirthday('1980-03-14', 'en-GB')).toBe('14 March 1980');
    const yearless = {
      id: '2',
      anniversaries: { a: { kind: 'birth', date: { month: 3, day: 14 } } },
    } as Card;
    expect(formatBirthday(cardBirthday(yearless), 'en-GB')).toBe('14 March');
    // Kept again, it still has no year.
    expect(
      cardOf(form({ birthday: cardBirthday(yearless) }))['anniversaries'],
    ).toEqual({ '1': { kind: 'birth', date: { month: 3, day: 14 } } });
  });

  it('needs something to be called by, and addresses that are addresses', () => {
    expect(formProblem(form())).toBeNull();
    expect(formProblem(form({ name: '', company: '', emails: [] }))).toBe(
      'Give a name, a company or an address.',
    );
    expect(
      formProblem(form({ emails: [{ kind: 'work', value: 'not one' }] })),
    ).toBe('“not one” is not an address.');
  });
});

describe('the list of contacts', () => {
  const cards = [
    { id: '1', name: { full: 'erik Sund' } },
    { id: '2', name: { full: 'Åsa Berg' }, notes: { n: { note: 'sailing' } } },
    { id: '3', name: { full: 'Aprilia Santoso' } },
    { id: '4', emails: { e: { address: '42@example.com' } } },
  ] as Card[];

  it('is in the order of a phone book, under the letter each name starts with', () => {
    expect(
      grouped(cards).map(
        (group) => `${group.letter}: ${group.cards.map(cardName).join(', ')}`,
      ),
    ).toEqual([
      '#: 42@example.com',
      'A: Aprilia Santoso, Åsa Berg',
      'E: erik Sund',
    ]);
  });

  it('is searched by anything a card says', () => {
    expect(searchCards(cards, 'sail').map((card) => card.id)).toEqual(['2']);
    expect(searchCards(cards, 'SUND erik').map((card) => card.id)).toEqual([
      '1',
    ]);
    expect(searchCards(cards, '  ')).toHaveLength(4);
    expect(searchCards(cards, 'nobody')).toEqual([]);
  });
});
