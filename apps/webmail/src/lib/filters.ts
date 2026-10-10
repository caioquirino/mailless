import type { JmapClient } from '@mailless/jmap-client';
import {
  CAPABILITY_SIEVE,
  parseSieve,
  RULE_MARK,
  sieveRuleKeyword,
  type Id,
  type SieveCommand,
  type SieveTest,
} from '@mailless/jmap-core';

/*
 * Filters: what is done with mail as it arrives. They are kept by the server
 * as one Sieve script (RFC 5228, RFC 9661), which is all there is: a filter
 * filled in on a form is a block of that script under a line with its name,
 * and is read back out of it. A block the form has no way to show is still
 * a filter, switched and ordered with the rest; it is "written by hand", and
 * changed in the script.
 */

export type Field = 'from' | 'to' | 'subject' | 'list' | 'larger' | 'attached';
export type How = 'contains' | 'is' | 'lacks';

/** Something a message has to be for a filter to act on it. */
export interface Condition {
  field: Field;
  /** For what is compared with words. */
  how: How;
  /** The words; for `larger`, megabytes. Nothing for `list` and `attached`. */
  value: string;
}

/** Something a filter does. */
export type Action =
  | { kind: 'move'; mailboxId: Id; name: string }
  | { kind: 'tag'; keyword: string }
  | { kind: 'read' }
  | { kind: 'star' };

/** A filter as the form has it. */
export interface Rule {
  name: string;
  /** Whether any one of the conditions is enough; all of them otherwise. */
  any: boolean;
  conditions: Condition[];
  actions: Action[];
  /** Whether the filters after this one are left untried. */
  stop: boolean;
}

/** One filter of the script: its name, whether it is in use, what it says, and the form's reading of it. */
export interface Block {
  name: string;
  on: boolean;
  /** The lines under its name, as they are in the script when it is on. */
  source: string;
  /** Null when it is written by hand: the form cannot show it. */
  rule: Rule | null;
}

/** A script, taken apart. */
export interface Filters {
  /** What comes before the first filter: what the script needs of the server. */
  head: string;
  blocks: Block[];
}

export const FIELDS: ReadonlyArray<{ field: Field; label: string }> = [
  { field: 'from', label: 'From' },
  { field: 'to', label: 'To or Cc' },
  { field: 'subject', label: 'Subject' },
  { field: 'list', label: 'Sent to a list' },
  { field: 'larger', label: 'Larger than' },
  { field: 'attached', label: 'Has an attachment' },
];

export const HOWS: ReadonlyArray<{ how: How; label: string }> = [
  { how: 'contains', label: 'contains' },
  { how: 'is', label: 'is' },
  { how: 'lacks', label: 'does not contain' },
];

/** Whether a field is compared with words, which `how` and `value` are for. */
export const worded = (field: Field) =>
  field === 'from' || field === 'to' || field === 'subject';

const HEAD = 'require ["fileinto", "imap4flags", "mailboxid", "copy"];';
const HEADERS: Record<string, string[]> = {
  from: ['from'],
  to: ['to', 'cc'],
  subject: ['subject'],
};

const quoted = (text: string) =>
  `"${text.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
const list = (texts: readonly string[]) =>
  texts.length === 1
    ? quoted(texts[0] as string)
    : `[${texts.map(quoted).join(', ')}]`;

function testOf(condition: Condition): string {
  const { field, how, value } = condition;
  if (field === 'list') return 'exists "list-id"';
  if (field === 'attached') {
    return 'header :contains "content-type" "multipart/mixed"';
  }
  if (field === 'larger') {
    return `size :over ${Math.max(1, Math.round(Number(value) || 1))}M`;
  }
  const kind = field === 'subject' ? 'header' : 'address';
  const test = `${kind} :${how === 'is' ? 'is' : 'contains'} ${list(HEADERS[field] ?? [])} ${quoted(value.trim())}`;
  return how === 'lacks' ? `not ${test}` : test;
}

/** A filter of the form, as the lines of script that do it. */
export function sourceOf(rule: Rule): string {
  const tests = rule.conditions.map(testOf);
  const test =
    tests.length === 0
      ? 'true'
      : tests.length === 1
        ? (tests[0] as string)
        : `${rule.any ? 'anyof' : 'allof'} (${tests.join(',\n          ')})`;
  const flags = rule.actions.flatMap((action) =>
    action.kind === 'tag'
      ? [action.keyword]
      : action.kind === 'read'
        ? ['\\Seen']
        : action.kind === 'star'
          ? ['\\Flagged']
          : [],
  );
  const lines = [
    ...(flags.length > 0 ? [`    addflag ${list(flags)};`] : []),
    // Marked first, so that it is filed with its marks.
    ...rule.actions.flatMap((action) =>
      action.kind === 'move'
        ? [
            `    fileinto :mailboxid ${quoted(action.mailboxId)} ${quoted(action.name)};`,
          ]
        : [],
    ),
    ...(rule.stop ? ['    stop;'] : []),
  ];
  return [`if ${test} {`, ...lines, '}'].join('\n');
}

function conditionOf(test: SieveTest): Condition | null {
  const lacks = test.kind === 'not';
  const inner = test.kind === 'not' ? test.test : test;
  if (inner.kind === 'exists' && !lacks) {
    return inner.headers.join().toLowerCase() === 'list-id'
      ? { field: 'list', how: 'contains', value: '' }
      : null;
  }
  if (inner.kind === 'size' && !lacks) {
    const megabytes = inner.limit / 1024 ** 2;
    return inner.over && Number.isInteger(megabytes) && megabytes >= 1
      ? { field: 'larger', how: 'contains', value: String(megabytes) }
      : null;
  }
  if (inner.kind !== 'header' && inner.kind !== 'address') return null;
  if (inner.exact || inner.part !== 'all' || inner.keys.length !== 1) {
    return null;
  }
  const headers = inner.headers.map((each) => each.toLowerCase()).join();
  const value = inner.keys[0] as string;
  if (
    inner.kind === 'header' &&
    headers === 'content-type' &&
    inner.match === 'contains' &&
    value === 'multipart/mixed' &&
    !lacks
  ) {
    return { field: 'attached', how: 'contains', value: '' };
  }
  const field = (Object.keys(HEADERS) as Field[]).find(
    (each) =>
      (HEADERS[each] ?? []).join() === headers &&
      (each === 'subject') === (inner.kind === 'header'),
  );
  if (!field || inner.match === 'matches') return null;
  if (lacks && inner.match !== 'contains') return null;
  return { field, how: lacks ? 'lacks' : inner.match, value };
}

/** A filter as the form would have it, when what the lines say is something the form can say. */
export function ruleOf(name: string, source: string): Rule | null {
  const script = parseSieve(`${HEAD}\n${source}`);
  const commands = script.commands.filter((each) => each.kind !== 'require');
  const [only] = commands;
  if (script.problems.length > 0 || commands.length !== 1) return null;
  if (only?.kind !== 'if' || only.branches.length !== 1 || only.otherwise) {
    return null;
  }
  const { test, block } = only.branches[0] as {
    test: SieveTest;
    block: SieveCommand[];
  };
  const several = test.kind === 'allof' || test.kind === 'anyof';
  const conditions = (
    several ? test.tests : test.kind === 'true' ? [] : [test]
  ).map(conditionOf);
  if (conditions.some((each) => each === null)) return null;
  const actions: Action[] = [];
  let stop = false;
  for (const [index, command] of block.entries()) {
    if (stop) return null;
    if (command.kind === 'addflag' && index === 0) {
      for (const flag of command.flags) {
        const lower = flag.toLowerCase();
        actions.push(
          lower === '\\seen'
            ? { kind: 'read' }
            : lower === '\\flagged'
              ? { kind: 'star' }
              : { kind: 'tag', keyword: flag },
        );
      }
    } else if (
      command.kind === 'fileinto' &&
      command.mailboxId !== null &&
      command.flags === null &&
      !command.copy &&
      !actions.some((each) => each.kind === 'move')
    ) {
      actions.push({
        kind: 'move',
        mailboxId: command.mailboxId,
        name: command.mailbox,
      });
    } else if (command.kind === 'stop') {
      stop = true;
    } else {
      return null;
    }
  }
  return {
    name,
    any: test.kind === 'anyof',
    conditions: conditions as Condition[],
    actions,
    stop,
  };
}

/** A script, as the filters in it. */
export function filtersOf(script: string): Filters {
  const lines = script.replace(/\r\n/g, '\n').split('\n');
  const head: string[] = [];
  const blocks: Array<{ name: string; on: boolean; lines: string[] }> = [];
  for (const line of lines) {
    const mark = RULE_MARK.exec(line.trim());
    if (mark) {
      blocks.push({ name: mark[1] ?? '', on: mark[2] !== 'off', lines: [] });
    } else if (blocks.length === 0) head.push(line);
    else blocks.at(-1)?.lines.push(line);
  }
  return {
    head: head.join('\n').trim(),
    blocks: blocks.map((each) => {
      const source = each.lines
        // One that is off is kept as comment, so that it does nothing and loses nothing.
        .map((line) => (each.on ? line : line.replace(/^#\| ?/, '')))
        .join('\n')
        .trim();
      return {
        name: each.name,
        on: each.on,
        source,
        rule: ruleOf(each.name, source),
      };
    }),
  };
}

/** The filters, as the script that is kept. */
export function scriptOf(filters: Filters): string {
  const parts = [filters.head.trim() === '' ? HEAD : filters.head.trim()];
  for (const block of filters.blocks) {
    const source = block.rule ? sourceOf(block.rule) : block.source;
    parts.push(
      [
        `# rule:[${block.name.replace(/[\][\r\n]/g, ' ').trim()}]${block.on ? '' : ' off'}`,
        ...(block.on
          ? [source]
          : source.split('\n').map((line) => `#| ${line}`)),
      ].join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

/** Whether what comes before the filters does anything itself: a script someone wrote without this page. */
export function headActs(head: string): boolean {
  return parseSieve(head).commands.some((each) => each.kind !== 'require');
}

/** A filter as one line says it: for the list. */
export function summaryOf(
  rule: Rule,
  names: { folder(id: Id, name: string): string; tag(keyword: string): string },
): { when: string; then: string } {
  const when = rule.conditions
    .map((each) => {
      const label =
        FIELDS.find((field) => field.field === each.field)?.label ?? '';
      if (each.field === 'larger') return `larger than ${each.value} MB`;
      if (!worded(each.field)) return label.toLowerCase();
      const how = HOWS.find((one) => one.how === each.how)?.label ?? '';
      return `${label.toLowerCase()} ${how} “${each.value}”`;
    })
    .join(rule.any ? ' or ' : ' and ');
  const then = rule.actions
    .map((each) =>
      each.kind === 'move'
        ? `move to ${names.folder(each.mailboxId, each.name)}`
        : each.kind === 'tag'
          ? `tag ${names.tag(each.keyword)}`
          : each.kind === 'read'
            ? 'mark read'
            : 'star',
    )
    .join(', ');
  return {
    when: when || 'any message',
    then: `${then || 'nothing'}${rule.stop ? ', then stop' : ''}`,
  };
}

/** What a script would do with one message. */
export interface Trial {
  /** Where it would be filed, by name; empty when it stays where it is. */
  folders: string[];
  mailboxIds: Id[];
  /** The marks it would be given. */
  flags: string[];
  /** Thrown away. */
  discarded: boolean;
  /** The filters that would do it. */
  rules: string[];
}

export class FilterError extends Error {}

/** The name the script this page keeps goes by on the server. */
const SCRIPT_NAME = 'mailless';

interface StoredScript {
  id: Id;
  name: string | null;
  blobId: Id;
  isActive: boolean;
}

/** The account's filters, as the server keeps them. */
export class FilterStore {
  /** Whether this server runs filters. Known once started. */
  available = false;
  /** The script in use, or the one this page made; its text. */
  script = '';
  private stored: StoredScript | null = null;
  private readonly listeners = new Set<() => void>();
  version = 0;

  constructor(private readonly client: JmapClient) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  private asked: Promise<void> | null = null;

  /** Fetches the script, the first time it is wanted. */
  ensure(): Promise<void> {
    this.asked ??= this.start().catch(() => {
      this.asked = null;
    });
    return this.asked;
  }

  /** Fetches the script. */
  async start(): Promise<void> {
    const session = await this.client.session();
    this.available = session.capabilities[CAPABILITY_SIEVE] !== undefined;
    if (!this.available) return;
    const got = (await this.client.call(
      'SieveScript/get' as never,
      { ids: null } as never,
    )) as { list: StoredScript[] };
    this.stored =
      got.list.find((each) => each.isActive) ??
      got.list.find((each) => each.name === SCRIPT_NAME) ??
      null;
    this.script = this.stored
      ? new TextDecoder().decode(await this.client.download(this.stored.blobId))
      : '';
    this.changed();
  }

  get filters(): Filters {
    return filtersOf(this.script);
  }

  private async blobOf(script: string): Promise<Id> {
    return (await this.client.upload(script, { type: 'application/sieve' }))
      .blobId;
  }

  /** What is wrong with a script; null when nothing is. */
  async check(script: string): Promise<string | null> {
    const [problem] = parseSieve(script).problems;
    if (problem) return `Line ${problem.line}: ${problem.message}`;
    const said = (await this.client.call(
      'SieveScript/validate' as never,
      { blobId: await this.blobOf(script) } as never,
    )) as { error: { description?: string } | null };
    return said.error
      ? (said.error.description ?? 'The script is wrong.')
      : null;
  }

  /** Keeps a script, and puts it in use. One that is wrong is not kept. */
  async save(script: string): Promise<void> {
    const problem = await this.check(script);
    if (problem) throw new FilterError(problem);
    const blobId = await this.blobOf(script);
    const response = (await this.client.call(
      'SieveScript/set' as never,
      (this.stored
        ? {
            update: { [this.stored.id]: { blobId } },
            onSuccessActivateScript: this.stored.id,
          }
        : {
            create: { new: { name: SCRIPT_NAME, blobId } },
            onSuccessActivateScript: '#new',
          }) as never,
    )) as {
      notCreated?: Record<string, { description?: string }> | null;
      notUpdated?: Record<string, { description?: string }> | null;
    };
    const [refused] = [
      ...Object.values(response.notCreated ?? {}),
      ...Object.values(response.notUpdated ?? {}),
    ];
    if (refused) {
      throw new FilterError(
        refused.description ?? 'The server would not keep the filters.',
      );
    }
    await this.start();
  }

  /** Keeps the filters, as the script they make. */
  saveFilters(filters: Filters): Promise<void> {
    return this.save(scriptOf(filters));
  }

  /** What a script would do with some messages, by the blob each is kept as. Nothing is done. */
  async tryOn(script: string, blobIds: readonly Id[]): Promise<Map<Id, Trial>> {
    const problem = await this.check(script);
    if (problem) throw new FilterError(problem);
    const scriptBlobId = await this.blobOf(script);
    const trials = new Map<Id, Trial>();
    for (let from = 0; from < blobIds.length; from += 50) {
      const said = (await this.client.call(
        'SieveScript/test' as never,
        {
          scriptBlobId,
          emailBlobIds: blobIds.slice(from, from + 50),
        } as never,
      )) as {
        completed: Record<Id, Array<[string, Record<string, unknown>]>> | null;
      };
      for (const [blobId, actions] of Object.entries(said.completed ?? {})) {
        const trial: Trial = {
          folders: [],
          mailboxIds: [],
          flags: [],
          discarded: false,
          rules: [],
        };
        for (const [name, args] of actions) {
          if (name === 'fileinto') {
            trial.folders.push(String(args['mailbox'] ?? ''));
            if (typeof args['mailboxId'] === 'string') {
              trial.mailboxIds.push(args['mailboxId']);
            }
          }
          if (name === 'fileinto' || name === 'keep') {
            trial.flags.push(...((args['flags'] as string[]) ?? []));
          }
          if (name === 'discard') trial.discarded = true;
          if (name === 'mailless:rules') {
            trial.rules = (args['names'] as string[]) ?? [];
          }
        }
        trial.flags = [...new Set(trial.flags)];
        trials.set(blobId, trial);
      }
    }
    return trials;
  }
}

/** The filter of these that marked a message: which one put it where it is. */
export function filedBy(
  keywords: Readonly<Record<string, boolean>>,
  blocks: readonly Block[],
): Block | undefined {
  return blocks.find((block) => keywords[sieveRuleKeyword(block.name)]);
}

/** A filter for messages like one: from whoever sent it, or to the list it came through. */
export function ruleLike(message: {
  from?: ReadonlyArray<{ email: string; name?: string | null }> | null;
  listId?: boolean;
}): Rule {
  const sender = message.from?.[0];
  return {
    name: sender?.name?.trim() || sender?.email || 'New filter',
    any: false,
    conditions: sender
      ? [{ field: 'from', how: 'is', value: sender.email.toLowerCase() }]
      : [],
    actions: [],
    stop: false,
  };
}
