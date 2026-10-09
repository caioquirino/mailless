import { ObjectCache, sync, type JmapClient } from '@mailless/jmap-client';
import { CAPABILITY_TAGS, type Email, type Id } from '@mailless/jmap-core';

/*
 * Tags: what a message is, where a folder is where it is. A message is in one
 * folder and can have any number of tags. Each is a keyword on the message
 * (RFC 8621 §4.1.1); the server keeps what the ones someone made are called
 * and what colour they are, so that every device shows the same.
 */

export interface Tag {
  id: Id;
  name: string;
  /** As `#rrggbb`. */
  color: string;
  /** The keyword a message with this tag has. */
  keyword: string;
  /** One of the two every account has, which cannot be changed or removed. */
  fixed?: 'starred' | 'important';
}

/** The star: the flag mail programs agree on, shown as a star and not as a chip. */
export const STARRED: Tag = {
  id: 'starred',
  name: 'Starred',
  color: '#b45309',
  keyword: '$flagged',
  fixed: 'starred',
};

/** What matters, said by whoever reads it: the keyword mail programs agree on for that. */
export const IMPORTANT: Tag = {
  id: 'important',
  name: 'Important',
  color: '#b45309',
  keyword: '$important',
  fixed: 'important',
};

/** The colours a tag can have: far enough apart to be told from one another, in light and in dark. */
export const TAG_COLORS: ReadonlyArray<{ color: string; name: string }> = [
  { color: '#b45309', name: 'Amber' },
  { color: '#b3261e', name: 'Red' },
  { color: '#7c3aed', name: 'Purple' },
  { color: '#2456c8', name: 'Blue' },
  { color: '#0e7490', name: 'Teal' },
  { color: '#1e7b4a', name: 'Green' },
  { color: '#5a6575', name: 'Grey' },
];

export class TagError extends Error {}

export class Tags {
  /** The tags someone made. */
  readonly made: ObjectCache<Tag>;
  /** Whether this server keeps tags. Known once started. */
  available = false;

  constructor(private readonly client: JmapClient) {
    this.made = new ObjectCache<Tag>(client, { type: 'Tag', everything: true });
  }

  /** Fetches them, where the server keeps any. */
  async start(): Promise<void> {
    const session = await this.client.session();
    this.available = session.capabilities[CAPABILITY_TAGS] !== undefined;
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

  /** Every tag: the two that are always there, then the rest by name. */
  all(): Tag[] {
    return [
      STARRED,
      IMPORTANT,
      ...[...this.made.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }

  /** The tag of a name, however it is written. */
  named(name: string): Tag | undefined {
    const wanted = name.trim().toLowerCase();
    return this.all().find((tag) => tag.name.toLowerCase() === wanted);
  }

  /** The tags any of some messages has, the star apart: it is shown as a star. */
  on(emails: readonly Email[]): Tag[] {
    return this.all().filter(
      (tag) =>
        tag.fixed !== 'starred' &&
        emails.some((email) => email.keywords[tag.keyword] === true),
    );
  }

  private async set(args: Record<string, unknown>): Promise<Id | undefined> {
    const response = (await this.client.call(
      'Tag/set' as never,
      args as never,
    )) as {
      created?: Record<string, { id: Id }> | null;
      notCreated?: Record<string, { type: string }> | null;
      notUpdated?: Record<string, { type: string }> | null;
      notDestroyed?: Record<string, { type: string }> | null;
    };
    const refused = [
      ...Object.values(response.notCreated ?? {}),
      ...Object.values(response.notUpdated ?? {}),
      ...Object.values(response.notDestroyed ?? {}),
    ].find((error) => error.type !== 'notFound');
    await this.refresh();
    if (refused) {
      throw new TagError(
        refused.type === 'invalidProperties'
          ? 'That cannot be a tag. Is there one with that name already?'
          : refused.type === 'overQuota'
            ? 'There are too many tags. Delete one first.'
            : 'The server refused the change.',
      );
    }
    return response.created?.['new']?.id;
  }

  /** Makes a tag. Returns it. */
  async make(name: string, color: string): Promise<Tag> {
    if (this.named(name)) throw new TagError('There is a tag with that name.');
    const id = await this.set({ create: { new: { name, color } } });
    const tag = id ? this.made.get(id) : undefined;
    if (!tag) throw new TagError('The tag could not be made.');
    return tag;
  }

  async change(
    id: Id,
    change: { name?: string; color?: string },
  ): Promise<void> {
    await this.set({ update: { [id]: change } });
  }

  /** Removes a tag. The mail that had it stays where it is, without it. */
  async remove(id: Id): Promise<void> {
    await this.set({ destroy: [id] });
  }
}
