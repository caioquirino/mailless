import type { JmapClient } from '@mailless/jmap-client';
import type { EmailAddress, Id } from '@mailless/jmap-core';
import type { Contacts } from './contacts';

/*
 * Who a message might be for: the people in the address book, and the
 * people written to before. Asked for when a message is first written, and
 * searched here, so that each letter typed asks the server nothing.
 */

export interface Person {
  name: string | null;
  email: string;
}

interface Known extends Person {
  /** How much they are someone the user writes to: more is offered first. */
  weight: number;
}

/** How many of the messages sent last are looked at for who they went to. */
const SENT_LOOKED_AT = 200;
/** What being in the address book counts for, in messages written to them. */
const IN_ADDRESS_BOOK = 3;

export class People {
  private readonly written = new Map<string, Known>();
  private started: Promise<void> | undefined;

  constructor(
    private readonly client: JmapClient,
    private readonly contacts: Contacts,
  ) {}

  /** Finds out who there is, once. Failing to is no reason not to write: nobody is suggested. */
  start(sentMailboxId: Id | undefined): Promise<void> {
    this.started ??= this.load(sentMailboxId).catch(() => undefined);
    return this.started;
  }

  private async load(sentMailboxId: Id | undefined): Promise<void> {
    // The address book, and who the messages sent last went to.
    const cards = this.contacts.start().catch(() => undefined);
    if (sentMailboxId !== undefined) {
      const batch = this.client.batch();
      const sent = batch.call('Email/query', {
        filter: { inMailbox: sentMailboxId },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: SENT_LOOKED_AT,
      });
      const recipients = batch.call('Email/get', {
        '#ids': sent.ref('/ids'),
        properties: ['to', 'cc', 'bcc'],
      });
      const result = await batch.send();
      if (result.ok(recipients)) {
        for (const email of result.get(recipients).list) {
          this.note([
            ...(email.to ?? []),
            ...(email.cc ?? []),
            ...(email.bcc ?? []),
          ]);
        }
      }
    }
    await cards;
  }

  /** How often someone was written to, of the messages looked at. */
  timesWritten(email: string): number {
    return this.written.get(email.toLowerCase())?.weight ?? 0;
  }

  /** A message went to these people: they are more likely to be written to again. */
  note(addresses: readonly EmailAddress[]): void {
    for (const address of addresses) {
      const key = address.email.toLowerCase();
      const known = this.written.get(key);
      if (known) {
        known.weight += 1;
        known.name ??= address.name?.trim() || null;
      } else {
        this.written.set(key, {
          name: address.name?.trim() || null,
          email: address.email,
          weight: 1,
        });
      }
    }
  }

  /**
   * The people what was typed could be the start of, the likeliest first.
   * `others` are people known from elsewhere, such as who wrote the mail
   * that is open; `without` are those the message is for already, and the
   * user's own addresses.
   */
  find(
    typed: string,
    options: {
      without?: readonly string[];
      others?: readonly EmailAddress[];
      most?: number;
    } = {},
  ): Person[] {
    const words = typed
      .toLowerCase()
      .split(/[\s,;<>"]+/)
      .filter(Boolean);
    if (words.length === 0) return [];
    const without = new Set(
      (options.without ?? []).map((each) => each.toLowerCase()),
    );
    const all = new Map<string, Known>();
    const add = (person: Person, weight: number) => {
      const key = person.email.toLowerCase();
      if (without.has(key) || !key.includes('@')) return;
      const known = all.get(key);
      if (known) {
        known.weight += weight;
        known.name ??= person.name;
      } else all.set(key, { ...person, weight });
    };
    for (const card of this.contacts.cards.values()) {
      for (const each of Object.values(card.emails ?? {})) {
        if (!each.address) continue;
        add(
          { name: card.name?.full?.trim() || null, email: each.address },
          IN_ADDRESS_BOOK,
        );
      }
    }
    for (const known of this.written.values()) add(known, known.weight);
    for (const other of options.others ?? []) {
      add({ name: other.name?.trim() || null, email: other.email }, 0.1);
    }

    const found: Array<Known & { starts: boolean }> = [];
    for (const person of all.values()) {
      const [local = '', domain = ''] = person.email.toLowerCase().split('@');
      // Where a word typed may begin: a name, the address, or what follows the "@".
      const pieces = [
        ...(person.name ?? '').toLowerCase().split(/[\s.,'-]+/),
        person.email.toLowerCase(),
        ...local.split(/[._+-]+/),
        domain,
      ].filter(Boolean);
      const whole = `${person.name ?? ''} ${person.email}`.toLowerCase();
      if (!words.every((word) => whole.includes(word))) continue;
      found.push({
        ...person,
        starts: words.every((word) =>
          pieces.some((piece) => piece.startsWith(word)),
        ),
      });
    }
    return found
      .sort(
        (a, b) =>
          Number(b.starts) - Number(a.starts) ||
          b.weight - a.weight ||
          a.email.localeCompare(b.email),
      )
      .slice(0, options.most ?? 6)
      .map(({ name, email }) => ({ name, email }));
  }
}
