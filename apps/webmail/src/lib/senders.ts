import { ObjectCache, sync, type JmapClient } from '@mailless/jmap-client';
import {
  CAPABILITY_BLOCKED_SENDERS,
  CAPABILITY_PICTURE_SENDERS,
  type Email,
  type EmailAddress,
  type Id,
} from '@mailless/jmap-core';
import { cardEmails, cardName, type Card } from './contacts';

/*
 * Who a message is from, and whether to believe it: the senders someone
 * wants no more mail from, and what there is to say about a sender before
 * what they wrote is trusted.
 */

export interface BlockedSender {
  id: Id;
  /** In small letters: an address, or `@example.com` for everyone at a domain. */
  address: string;
}

export class SenderError extends Error {}

/** One address, or with nothing before the `@` everyone at a domain. */
const BLOCKABLE = /^[^@\s]*@[^@\s]+\.[^@\s]+$/;

/** The senders whose mail the server files as junk when it arrives. */
export class Blocked {
  readonly made: ObjectCache<BlockedSender>;
  /** Whether this server keeps blocked senders. Known once started. */
  available = false;

  constructor(private readonly client: JmapClient) {
    this.made = new ObjectCache<BlockedSender>(client, {
      type: 'BlockedSender',
      everything: true,
    });
  }

  /** Fetches them, where the server keeps any. */
  async start(): Promise<void> {
    const session = await this.client.session();
    this.available =
      session.capabilities[CAPABILITY_BLOCKED_SENDERS] !== undefined;
    if (!this.available) return;
    const batch = this.client.batch();
    const made = this.made.loadIn(batch, null);
    made.done(await batch.send());
  }

  /** Brings them up to date with what another device changed. */
  async refresh(): Promise<void> {
    if (!this.available || !this.made.isComplete) return;
    await sync(this.client, [this.made]);
  }

  /** Every blocked sender: whole domains first, then addresses, by name. */
  all(): BlockedSender[] {
    return [...this.made.values()].sort(
      (a, b) =>
        Number(b.address.startsWith('@')) - Number(a.address.startsWith('@')) ||
        a.address.localeCompare(b.address),
    );
  }

  /** What blocks an address: the address itself, or its domain. */
  blocking(email: string): BlockedSender | undefined {
    const address = email.trim().toLowerCase();
    const domain = address.slice(address.lastIndexOf('@'));
    const all = this.made.values();
    return (
      all.find((each) => each.address === address) ??
      all.find((each) => each.address === domain)
    );
  }

  private async set(args: Record<string, unknown>): Promise<void> {
    const response = (await this.client.call(
      'BlockedSender/set' as never,
      args as never,
    )) as {
      notCreated?: Record<string, { type: string }> | null;
      notDestroyed?: Record<string, { type: string }> | null;
    };
    const refused = [
      ...Object.values(response.notCreated ?? {}),
      ...Object.values(response.notDestroyed ?? {}),
    ].find((error) => error.type !== 'notFound');
    await this.refresh();
    if (refused) {
      throw new SenderError(
        refused.type === 'overQuota'
          ? 'There are too many blocked senders. Remove one first.'
          : 'That cannot be blocked. It has to be an address, or @ and a domain.',
      );
    }
  }

  /** Files what an address, or a whole domain, sends from now on as junk. */
  async block(address: string): Promise<void> {
    const wanted = address.trim().toLowerCase();
    if (!BLOCKABLE.test(wanted)) {
      throw new SenderError(
        'That cannot be blocked. It has to be an address, or @ and a domain.',
      );
    }
    if (this.made.values().some((each) => each.address === wanted)) return;
    await this.set({ create: { new: { address: wanted } } });
  }

  /** Lets mail from an address, or a domain, arrive as any other again. */
  async unblock(address: string): Promise<void> {
    const wanted = address.trim().toLowerCase();
    const ids = this.made
      .values()
      .filter((each) => each.address === wanted)
      .map((each) => each.id);
    if (ids.length > 0) await this.set({ destroy: ids });
  }
}

/** A sender, or everyone at a domain, whose mail is shown with its pictures. */
export type PictureSender = BlockedSender;

/**
 * The senders whose mail is shown with the pictures it keeps on other sites.
 * Loading such a picture tells whoever sent it that the message was opened:
 * these are the ones the person has said may know. Kept by the server, so
 * that it is the same wherever the person reads their mail.
 */
export class Pictures {
  readonly made: ObjectCache<PictureSender>;
  /** Whether this server keeps them. Known once started. */
  available = false;

  constructor(private readonly client: JmapClient) {
    this.made = new ObjectCache<PictureSender>(client, {
      type: 'PictureSender',
      everything: true,
    });
  }

  async start(): Promise<void> {
    const session = await this.client.session();
    this.available =
      session.capabilities[CAPABILITY_PICTURE_SENDERS] !== undefined;
    if (!this.available) return;
    const batch = this.client.batch();
    const made = this.made.loadIn(batch, null);
    made.done(await batch.send());
  }

  async refresh(): Promise<void> {
    if (!this.available || !this.made.isComplete) return;
    await sync(this.client, [this.made]);
  }

  /** All of them: whole domains first, then addresses, by name. */
  all(): PictureSender[] {
    return [...this.made.values()].sort(
      (a, b) =>
        Number(b.address.startsWith('@')) - Number(a.address.startsWith('@')) ||
        a.address.localeCompare(b.address),
    );
  }

  /** What has the pictures of an address shown: the address itself, or its domain. */
  showing(email: string): PictureSender | undefined {
    const address = email.trim().toLowerCase();
    const domain = address.slice(address.lastIndexOf('@'));
    const all = this.made.values();
    return (
      all.find((each) => each.address === address) ??
      all.find((each) => each.address === domain)
    );
  }

  private async set(args: Record<string, unknown>): Promise<void> {
    const response = (await this.client.call(
      'PictureSender/set' as never,
      args as never,
    )) as {
      notCreated?: Record<string, { type: string }> | null;
      notDestroyed?: Record<string, { type: string }> | null;
    };
    const refused = [
      ...Object.values(response.notCreated ?? {}),
      ...Object.values(response.notDestroyed ?? {}),
    ].find((error) => error.type !== 'notFound');
    await this.refresh();
    if (refused) {
      throw new SenderError(
        refused.type === 'overQuota'
          ? 'There are too many of these. Remove one first.'
          : 'That cannot be kept. It has to be an address, or @ and a domain.',
      );
    }
  }

  /** Shows the pictures of what an address, or a whole domain, sends from now on. */
  async always(address: string): Promise<void> {
    const wanted = address.trim().toLowerCase();
    if (!BLOCKABLE.test(wanted)) {
      throw new SenderError(
        'That cannot be kept. It has to be an address, or @ and a domain.',
      );
    }
    if (this.made.values().some((each) => each.address === wanted)) return;
    await this.set({ create: { new: { address: wanted } } });
  }

  /** Asks again before showing the pictures of an address, or a domain. */
  async ask(address: string): Promise<void> {
    const wanted = address.trim().toLowerCase();
    const ids = this.made
      .values()
      .filter((each) => each.address === wanted)
      .map((each) => each.id);
    if (ids.length > 0) await this.set({ destroy: ids });
  }
}

/** On mail that claims a sender its domain does not vouch for, or that someone reported. */
export const PHISHING = '$phishing';
/** On mail nothing vouches for: set by the server when it arrives. */
export const UNVERIFIED = 'mailless-unverified';

/** Something to know about who a message is from, before believing it. */
export type Caution =
  /** It failed its domain's own check, or was reported: what forged mail looks like. */
  | { kind: 'forged'; domain: string }
  /** Nothing confirms where it comes from. */
  | { kind: 'unverified'; domain: string }
  /** It bears the name of someone known, and not their address. */
  | { kind: 'namesake'; name: string; own: boolean };

const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf('@') + 1).toLowerCase();

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What there is to say about the sender of a message that arrived, from what
 * the server marked on it and from who is known. Nothing for what the reader
 * wrote themselves.
 */
export function cautions(
  email: Pick<Email, 'from' | 'keywords'>,
  known: {
    /** Who the reader writes as. */
    own: readonly EmailAddress[];
    /** The reader's addresses elsewhere: mail from them bears their name rightly. */
    others?: readonly string[];
    cards: readonly Card[];
  },
): Caution[] {
  const sender = email.from?.[0];
  if (!sender || email.keywords['$draft']) return [];
  if (known.own.some((each) => same(each.email, sender.email))) return [];
  const found: Caution[] = [];
  const domain = domainOf(sender.email);
  if (email.keywords[PHISHING]) found.push({ kind: 'forged', domain });
  else if (email.keywords[UNVERIFIED]) {
    found.push({ kind: 'unverified', domain });
  }

  // A name is whatever the sender typed: the address is what tells people apart.
  const name = sender.name?.trim() ?? '';
  const theirs = (known.others ?? []).some((each) => same(each, sender.email));
  if (name !== '' && !name.includes('@') && !theirs) {
    if (known.own.some((each) => each.name && same(each.name, name))) {
      found.push({ kind: 'namesake', name, own: true });
    } else {
      const namesakes = known.cards.filter((card) =>
        same(cardName(card), name),
      );
      if (
        namesakes.length > 0 &&
        !namesakes.some((card) =>
          cardEmails(card).some((each) => same(each.value, sender.email)),
        )
      ) {
        found.push({ kind: 'namesake', name, own: false });
      }
    }
  }
  return found;
}

/**
 * Whether a message is the first there is from its sender: nothing that
 * arrived before it bears the address. Asked of the server, once per message.
 */
export class FirstTimes {
  private readonly asked = new Map<Id, Promise<boolean>>();

  constructor(private readonly client: JmapClient) {}

  of(email: Pick<Email, 'id' | 'from' | 'receivedAt'>): Promise<boolean> {
    const sender = email.from?.[0]?.email;
    if (!sender) return Promise.resolve(false);
    let answer = this.asked.get(email.id);
    if (!answer) {
      answer = this.client
        .call('Email/query', {
          filter: {
            operator: 'AND',
            conditions: [{ from: sender }, { before: email.receivedAt }],
          },
          limit: 1,
        })
        .then((found) => found.ids.length === 0)
        // Not knowing is not a reason to say so.
        .catch(() => false);
      this.asked.set(email.id, answer);
    }
    return answer;
  }
}

/** Where anyone can have an address: one sender there says nothing of the others. */
const SHARED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  'mail.com',
  'yandex.com',
  'zoho.com',
  'fastmail.com',
]);

/**
 * Whose pictures a message's could always be shown as: its sender, and the
 * sender's domain where that is one organisation's. Nobody, for a message
 * nothing vouches for: anyone can write a name on a letter.
 */
export function pictureChoices(email: Email): string[] {
  if (email.keywords[PHISHING] || email.keywords[UNVERIFIED]) return [];
  const address = email.from?.[0]?.email.trim().toLowerCase() ?? '';
  if (!BLOCKABLE.test(address) || address.startsWith('@')) return [];
  const domain = domainOf(address);
  return SHARED_DOMAINS.has(domain) ? [address] : [address, `@${domain}`];
}
