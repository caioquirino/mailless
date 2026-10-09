import { ObjectCache, sync, type JmapClient } from '@mailless/jmap-client';
import { CAPABILITY_CONTACTS } from '@mailless/jmap-core';
import type { Id } from '@mailless/jmap-core';

/*
 * The address book: the people kept in it, and the books they are kept in.
 * A person is a card as mail programs agree to write one (JSContact, RFC
 * 9553), of which this page reads and writes the parts people fill in.
 */

export interface AddressBook {
  id: Id;
  name: string;
  isDefault?: boolean;
}

type Contexts = Record<string, boolean>;

/** As much of a card as this page shows. Whatever else a card holds is left as it is. */
export interface Card {
  id: Id;
  addressBookIds?: Record<Id, boolean>;
  name?: { full?: string } | null;
  emails?: Record<string, { address?: string; contexts?: Contexts }> | null;
  phones?: Record<
    string,
    { number?: string; contexts?: Contexts; features?: Contexts }
  > | null;
  organizations?: Record<string, { name?: string }> | null;
  titles?: Record<string, { name?: string }> | null;
  addresses?: Record<string, { full?: string }> | null;
  anniversaries?: Record<
    string,
    { kind?: string; date?: { year?: number; month?: number; day?: number } }
  > | null;
  notes?: Record<string, { note?: string }> | null;
  media?: Record<
    string,
    { kind?: string; blobId?: string; mediaType?: string }
  > | null;
}

export type Kind = 'work' | 'home' | 'mobile' | 'other';

/** A card as the form to fill one in holds it. */
export interface CardForm {
  name: string;
  company: string;
  title: string;
  emails: Array<{ kind: Kind; value: string }>;
  phones: Array<{ kind: Kind; value: string }>;
  address: string;
  /** As a date field holds it: `2000-03-14`, or nothing. */
  birthday: string;
  notes: string;
  bookId: Id;
  /** The picture, as something uploaded or already kept. */
  photo: string | null;
}

const first = <T>(map: Record<string, T> | null | undefined): T | undefined =>
  Object.values(map ?? {})[0];

function kindOf(entry: { contexts?: Contexts; features?: Contexts }): Kind {
  if (entry.features?.['mobile']) return 'mobile';
  if (entry.contexts?.['work']) return 'work';
  if (entry.contexts?.['private']) return 'home';
  return 'other';
}

function marks(kind: Kind): { contexts?: Contexts; features?: Contexts } {
  if (kind === 'work') return { contexts: { work: true } };
  if (kind === 'home') return { contexts: { private: true } };
  if (kind === 'mobile') return { features: { mobile: true } };
  return {};
}

export const KIND_NAMES: Record<Kind, string> = {
  work: 'Work',
  home: 'Home',
  mobile: 'Mobile',
  other: 'Other',
};

/** What someone is called: their name, or failing that where they are written to. */
export function cardName(card: Card): string {
  return (
    card.name?.full?.trim() ||
    first(card.organizations)?.name?.trim() ||
    first(card.emails)?.address?.trim() ||
    '(no name)'
  );
}

/** A line about someone, under their name: what they do and where, or their address. */
export function cardAbout(card: Card): string {
  const work = [first(card.titles)?.name, first(card.organizations)?.name]
    .map((each) => each?.trim())
    .filter(Boolean);
  if (card.name?.full?.trim() && work.length > 0) return work.join(' · ');
  const address = first(card.emails)?.address?.trim() ?? '';
  return address === cardName(card) ? '' : address;
}

export function cardEmails(card: Card): Array<{ kind: Kind; value: string }> {
  return Object.values(card.emails ?? {})
    .filter((each) => (each.address ?? '').trim() !== '')
    .map((each) => ({ kind: kindOf(each), value: each.address as string }));
}

export function cardPhones(card: Card): Array<{ kind: Kind; value: string }> {
  return Object.values(card.phones ?? {})
    .filter((each) => (each.number ?? '').trim() !== '')
    .map((each) => ({ kind: kindOf(each), value: each.number as string }));
}

export function cardPhoto(card: Card): string | null {
  return (
    Object.values(card.media ?? {}).find(
      (each) => each.kind === 'photo' && each.blobId,
    )?.blobId ?? null
  );
}

/** The day someone was born, as a date field holds it; empty when the card does not say. */
export function cardBirthday(card: Card): string {
  const date = Object.values(card.anniversaries ?? {}).find(
    (each) => each.kind === 'birth',
  )?.date;
  if (!date?.month || !date.day) return '';
  const two = (value: number) => String(value).padStart(2, '0');
  // A year nobody gave is written as one no birthday has, to be left out again.
  const year = String(date.year ?? 1604).padStart(4, '0');
  return `${year}-${two(date.month)}-${two(date.day)}`;
}

/** A birthday in words: without the year, when the card does not say it. */
export function formatBirthday(birthday: string, locale?: string): string {
  const [year, month, day] = birthday.split('-').map(Number);
  if (!month || !day) return '';
  const known = year !== 1604;
  return new Date(
    Date.UTC(known ? (year as number) : 2000, month - 1, day),
  ).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    ...(known ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

export function formOf(card: Card | undefined, bookId: Id): CardForm {
  return {
    name: card?.name?.full ?? '',
    company: first(card?.organizations)?.name ?? '',
    title: first(card?.titles)?.name ?? '',
    emails: card ? cardEmails(card) : [],
    phones: card ? cardPhones(card) : [],
    address: first(card?.addresses)?.full ?? '',
    birthday: card ? cardBirthday(card) : '',
    notes: first(card?.notes)?.note ?? '',
    bookId: Object.keys(card?.addressBookIds ?? {})[0] ?? bookId,
    photo: card ? cardPhoto(card) : null,
  };
}

/** What a filled-in form makes of a card: each part as it is now, or gone when left empty. */
export function cardOf(form: CardForm): Record<string, unknown> {
  const one = <T>(value: string, make: (text: string) => T) =>
    value.trim() === '' ? null : { '1': make(value.trim()) };
  const many = <T>(
    rows: CardForm['emails'],
    make: (text: string, kind: Kind) => T,
  ) => {
    const filled = rows.filter((row) => row.value.trim() !== '');
    return filled.length === 0
      ? null
      : Object.fromEntries(
          filled.map((row, index) => [
            String(index + 1),
            make(row.value.trim(), row.kind),
          ]),
        );
  };
  const [year, month, day] = form.birthday.split('-').map(Number);
  return {
    addressBookIds: { [form.bookId]: true },
    name: form.name.trim() === '' ? null : { full: form.name.trim() },
    organizations: one(form.company, (name) => ({ name })),
    titles: one(form.title, (name) => ({ name })),
    emails: many(form.emails, (address, kind) => ({
      address,
      ...marks(kind),
    })),
    phones: many(form.phones, (number, kind) => ({ number, ...marks(kind) })),
    addresses: one(form.address, (full) => ({ full })),
    anniversaries:
      month && day
        ? {
            '1': {
              kind: 'birth',
              date: { ...(year && year !== 1604 ? { year } : {}), month, day },
            },
          }
        : null,
    notes: one(form.notes, (note) => ({ note })),
    media: form.photo ? { '1': { kind: 'photo', blobId: form.photo } } : null,
  };
}

/** What stands between a form and being a card, in words; null when nothing does. */
export function formProblem(form: CardForm): string | null {
  const said =
    form.name.trim() !== '' ||
    form.company.trim() !== '' ||
    form.emails.some((each) => each.value.trim() !== '');
  if (!said) return 'Give a name, a company or an address.';
  const bad = form.emails.find(
    (each) =>
      each.value.trim() !== '' &&
      !/^[^\s@<>"',;]+@[^\s@<>"',;]+$/.test(each.value.trim()),
  );
  return bad ? `“${bad.value.trim()}” is not an address.` : null;
}

/** People in the order of a phone book, with the letter each group starts under. */
export function grouped(
  cards: readonly Card[],
): Array<{ letter: string; cards: Card[] }> {
  const groups = new Map<string, Card[]>();
  const sorted = [...cards].sort((a, b) =>
    cardName(a).localeCompare(cardName(b), undefined, { sensitivity: 'base' }),
  );
  for (const card of sorted) {
    const initial =
      [...cardName(card).normalize('NFD')][0]?.toUpperCase() ?? '';
    const letter = /\p{L}/u.test(initial) ? initial : '#';
    groups.set(letter, [...(groups.get(letter) ?? []), card]);
  }
  return [...groups].map(([letter, each]) => ({ letter, cards: each }));
}

/** The cards that have every word typed somewhere in what they say. */
export function searchCards(cards: readonly Card[], typed: string): Card[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...cards];
  return cards.filter((card) => {
    const text = [
      card.name?.full,
      ...Object.values(card.organizations ?? {}).map((each) => each.name),
      ...Object.values(card.titles ?? {}).map((each) => each.name),
      ...Object.values(card.emails ?? {}).map((each) => each.address),
      ...Object.values(card.phones ?? {}).map((each) => each.number),
      ...Object.values(card.notes ?? {}).map((each) => each.note),
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * The pictures kept with cards, fetched as they are first shown and held
 * for as long as the page is open. A picture is asked for by the blob it is
 * kept as, and is there, as an address this page can show, once it has come.
 */
export class Photos {
  private readonly urls = new Map<Id, string | null>();
  private readonly listeners = new Set<() => void>();
  version = 0;

  constructor(private readonly client: JmapClient) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Where a picture can be shown from. Nothing yet, the first time it is asked for. */
  url(blobId: Id): string | undefined {
    if (!this.urls.has(blobId)) {
      this.urls.set(blobId, null);
      void this.client
        .download(blobId, { name: 'photo', type: 'application/octet-stream' })
        .then((bytes) => {
          this.urls.set(
            blobId,
            URL.createObjectURL(new Blob([bytes as BlobPart])),
          );
          this.version++;
          for (const listener of [...this.listeners]) listener();
        })
        // Not there, or not now: the initial stands in, and it is not asked for again.
        .catch(() => undefined);
    }
    return this.urls.get(blobId) ?? undefined;
  }
}

export class Contacts {
  readonly books: ObjectCache<AddressBook>;
  readonly cards: ObjectCache<Card>;
  /** Whether this server keeps an address book at all. Known once started. */
  available = false;
  readonly photos: Photos;
  private started: Promise<void> | undefined;
  private faces: { version: number; byEmail: Map<string, Card> } | undefined;

  constructor(private readonly client: JmapClient) {
    this.photos = new Photos(client);
    this.books = new ObjectCache<AddressBook>(client, {
      type: 'AddressBook',
      everything: true,
    });
    this.cards = new ObjectCache<Card>(client, {
      type: 'ContactCard',
      everything: true,
    });
  }

  /** Fetches the books and everyone in them, once. */
  start(): Promise<void> {
    this.started ??= this.load().catch((error: unknown) => {
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  private async load(): Promise<void> {
    const session = await this.client.session();
    this.available = session.capabilities[CAPABILITY_CONTACTS] !== undefined;
    if (!this.available) return;
    const batch = this.client.batch();
    const books = this.books.loadIn(batch, null);
    const cards = this.cards.loadIn(batch, null);
    const result = await batch.send();
    books.done(result);
    cards.done(result);
  }

  /** The card of whoever has an address, when they are in the address book. */
  cardFor(email: string): Card | undefined {
    const version = this.cards.version;
    if (this.faces?.version !== version) {
      const byEmail = new Map<string, Card>();
      for (const card of this.cards.values()) {
        for (const each of cardEmails(card)) {
          const key = each.value.toLowerCase();
          // Of two cards with one address, the one with a picture is the one shown.
          if (!byEmail.has(key) || cardPhoto(card)) byEmail.set(key, card);
        }
      }
      this.faces = { version, byEmail };
    }
    return this.faces.byEmail.get(email.toLowerCase());
  }

  /**
   * Keeps a picture for an address: on the card that has the address, or on
   * a new one when none does. `blobId` null takes the picture away.
   */
  async setPhoto(
    person: { name: string | null; email: string },
    blobId: Id | null,
  ): Promise<void> {
    const card = this.cardFor(person.email);
    const media = blobId ? { '1': { kind: 'photo', blobId } } : null;
    if (card) await this.save(card.id, { media });
    else if (blobId) {
      const book = this.defaultBook();
      if (!book) throw new Error('There is no address book to keep it in.');
      await this.save(null, {
        addressBookIds: { [book.id]: true },
        ...(person.name ? { name: { full: person.name } } : {}),
        emails: { '1': { address: person.email } },
        media,
      });
    }
  }

  /**
   * The card of the person themselves: the one with an address they write
   * from on it. It is where their other addresses are kept, as anyone's are.
   */
  ownCard(own: readonly { email: string }[]): Card | undefined {
    return own
      .map((each) => this.cardFor(each.email))
      .find((card): card is Card => card !== undefined);
  }

  /** The person's addresses elsewhere: those on their own card that are not ones they write from here. */
  otherAddresses(own: readonly { email: string }[]): string[] {
    const here = new Set(own.map((each) => each.email.toLowerCase()));
    const card = this.ownCard(own);
    return card
      ? cardEmails(card)
          .map((each) => each.value.trim().toLowerCase())
          .filter((address) => address !== '' && !here.has(address))
      : [];
  }

  /** Says which the person's addresses elsewhere are, on their own card: made when there is none yet. */
  async setOtherAddresses(
    own: readonly { email: string; name?: string | null }[],
    others: readonly string[],
  ): Promise<void> {
    const here = new Set(own.map((each) => each.email.toLowerCase()));
    const wanted = [
      ...new Set(others.map((address) => address.trim().toLowerCase())),
    ].filter((address) => address !== '' && !here.has(address));
    const card = this.ownCard(own);
    // What the card says of the addresses written from here stays as it is.
    const kept = Object.entries(card?.emails ?? {}).filter(([, each]) =>
      here.has((each.address ?? '').toLowerCase()),
    );
    const emails = Object.fromEntries([
      ...kept,
      ...wanted.map((address, index) => [`other${index + 1}`, { address }]),
    ]);
    if (card) {
      await this.save(card.id, { emails });
    } else {
      const [first] = own;
      const book = this.defaultBook();
      if (!first || !book) {
        throw new Error('There is no address book to keep it in.');
      }
      await this.save(null, {
        addressBookIds: { [book.id]: true },
        ...(first.name ? { name: { full: first.name } } : {}),
        emails: { own1: { address: first.email }, ...emails },
      });
    }
    await this.refresh();
  }

  /** Brings what is held up to date with what another device changed. */
  async refresh(): Promise<void> {
    if (!this.available || !this.cards.isComplete) return;
    await sync(this.client, [this.books, this.cards]);
  }

  /** The book new people go in when none is chosen. */
  defaultBook(): AddressBook | undefined {
    const books = this.books.values();
    return books.find((book) => book.isDefault) ?? books[0];
  }

  /** Keeps a card: a new one when `id` is null. Returns its id. Throws what the server said. */
  async save(id: Id | null, card: Record<string, unknown>): Promise<Id> {
    const call = (args: Record<string, unknown>) =>
      this.client.call('ContactCard/set' as never, args as never) as Promise<{
        created?: Record<string, { id: Id }> | null;
        notCreated?: Record<string, { description?: string }> | null;
        notUpdated?: Record<string, { description?: string }> | null;
      }>;
    let kept = id;
    if (id === null) {
      // A new card says only what it has: nothing is there to take away.
      const said = Object.fromEntries(
        Object.entries(card).filter(([, value]) => value !== null),
      );
      const response = await call({ create: { card: said } });
      kept = response.created?.['card']?.id ?? null;
      if (!kept) {
        throw new Error(
          response.notCreated?.['card']?.description ??
            'The contact could not be kept.',
        );
      }
    } else {
      const response = await call({ update: { [id]: card } });
      const refused = response.notUpdated?.[id];
      if (refused) {
        throw new Error(
          refused.description ?? 'The contact could not be kept.',
        );
      }
    }
    await this.refresh();
    return kept as Id;
  }

  async remove(id: Id): Promise<void> {
    await this.client.call(
      'ContactCard/set' as never,
      { destroy: [id] } as never,
    );
    await this.refresh();
  }
}
