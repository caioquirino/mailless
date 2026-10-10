/*
 * Sieve (RFC 5228): the language mail filters are written in. What is here
 * reads a script, says what is wrong with one, and works out what a script
 * would do with a message. It touches nothing: whoever asks does what it
 * says, or only shows it.
 *
 * Of the language: `if`/`elsif`/`else`, `stop`, `keep`, `discard`; the tests
 * `address`, `header`, `exists`, `size`, `allof`, `anyof`, `not`, `true`,
 * `false`; matching by `:is`, `:contains` and `:matches`. Of its extensions:
 * `fileinto` (RFC 5228), `imap4flags` (RFC 5232), `mailboxid` (RFC 9042) and
 * `copy` (RFC 3894). A script that asks for anything else is refused, with
 * the line it asks on.
 */

/** What is wrong with a script, and where. */
export interface SieveProblem {
  line: number;
  message: string;
}

export type SieveMatch = 'is' | 'contains' | 'matches';

export type SieveTest =
  | { kind: 'true' | 'false' }
  | { kind: 'not'; test: SieveTest }
  | { kind: 'allof' | 'anyof'; tests: SieveTest[] }
  | { kind: 'exists'; headers: string[] }
  | { kind: 'size'; over: boolean; limit: number }
  | {
      kind: 'header' | 'address';
      match: SieveMatch;
      /** For an address: all of it, or what is before or after the `@`. */
      part: 'all' | 'localpart' | 'domain';
      /** Compared letter for letter, capitals and all. */
      exact: boolean;
      headers: string[];
      keys: string[];
    };

export type SieveCommand = { line: number } & (
  | { kind: 'require'; names: string[] }
  | {
      kind: 'if';
      branches: Array<{ test: SieveTest; block: SieveCommand[] }>;
      otherwise: SieveCommand[] | null;
    }
  | { kind: 'stop' | 'keep' | 'discard' }
  | {
      kind: 'fileinto';
      mailbox: string;
      /** The mailbox by what the server knows it as, which outlives its name. */
      mailboxId: string | null;
      flags: string[] | null;
      copy: boolean;
    }
  | { kind: 'addflag' | 'setflag' | 'removeflag'; flags: string[] }
);

/** A script, read. */
export interface SieveScript {
  commands: SieveCommand[];
  /** Which of the commands at the top each named filter is: the name, by the command's place. */
  rules: Array<string | null>;
  problems: SieveProblem[];
}

/** The line a filter made in a form starts with, so that it can be found again. */
export const RULE_MARK = /^#\s*rule:\[(.*)\]\s*(off)?\s*$/;

const EXTENSIONS = ['fileinto', 'imap4flags', 'mailboxid', 'copy'];
/** What each command or argument needs asked for first. */
const NEEDS: Record<string, string> = {
  fileinto: 'fileinto',
  addflag: 'imap4flags',
  setflag: 'imap4flags',
  removeflag: 'imap4flags',
  ':flags': 'imap4flags',
  ':mailboxid': 'mailboxid',
  ':copy': 'copy',
};

type Token =
  | { type: 'word' | 'tag' | 'string' | 'punct'; value: string; line: number }
  | { type: 'number'; value: string; number: number; line: number }
  | { type: 'comment'; value: string; line: number };

class Refused extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

function tokens(text: string): Token[] {
  const found: Token[] = [];
  let at = 0;
  let line = 1;
  const rest = () => text.slice(at);
  while (at < text.length) {
    const letter = text[at] as string;
    if (letter === '\n') {
      line++;
      at++;
    } else if (/\s/.test(letter)) {
      at++;
    } else if (letter === '#') {
      const end = text.indexOf('\n', at);
      const value = text.slice(at, end < 0 ? text.length : end).trimEnd();
      found.push({ type: 'comment', value, line });
      at = end < 0 ? text.length : end;
    } else if (rest().startsWith('/*')) {
      const end = text.indexOf('*/', at + 2);
      if (end < 0)
        throw new Refused(line, 'A comment is opened and not closed');
      line += text.slice(at, end).split('\n').length - 1;
      at = end + 2;
    } else if (letter === '"') {
      const start = line;
      let value = '';
      at++;
      for (;;) {
        if (at >= text.length) {
          throw new Refused(start, 'A " is opened and not closed');
        }
        const next = text[at] as string;
        if (next === '"') break;
        if (next === '\\' && at + 1 < text.length) {
          value += text[at + 1];
          at += 2;
          continue;
        }
        if (next === '\n') line++;
        value += next;
        at++;
      }
      at++;
      found.push({ type: 'string', value, line: start });
    } else if (/^text:[ \t]*(#[^\n]*)?\r?\n/.test(rest())) {
      // Text of several lines, up to a line with only a dot on it.
      const start = line;
      at = text.indexOf('\n', at) + 1;
      line++;
      const lines: string[] = [];
      for (;;) {
        if (at >= text.length) {
          throw new Refused(start, 'A text: is not ended by a line with a dot');
        }
        const end = text.indexOf('\n', at);
        const one = text
          .slice(at, end < 0 ? text.length : end)
          .replace(/\r$/, '');
        at = end < 0 ? text.length : end + 1;
        line++;
        if (one === '.') break;
        lines.push(one.startsWith('..') ? one.slice(1) : one);
      }
      found.push({ type: 'string', value: lines.join('\r\n'), line: start });
    } else if (letter === ':') {
      const word = /^:[A-Za-z_][A-Za-z0-9_]*/.exec(rest());
      if (!word) throw new Refused(line, 'A ":" with nothing after it');
      found.push({ type: 'tag', value: word[0].toLowerCase(), line });
      at += word[0].length;
    } else if (/[0-9]/.test(letter)) {
      const number = /^([0-9]+)([KMG])?/i.exec(rest()) as RegExpExecArray;
      const times = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
        (number[2] ?? '').toLowerCase()
      ];
      found.push({
        type: 'number',
        value: number[0],
        number: Number(number[1]) * (times ?? 1),
        line,
      });
      at += number[0].length;
    } else if (/[A-Za-z_]/.test(letter)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest()) as RegExpExecArray;
      found.push({ type: 'word', value: word[0].toLowerCase(), line });
      at += word[0].length;
    } else if ('[]{}(),;'.includes(letter)) {
      found.push({ type: 'punct', value: letter, line });
      at++;
    } else {
      throw new Refused(line, `“${letter}” is not part of a script`);
    }
  }
  return found;
}

/** Reads a script. What is wrong with it is in `problems`; with any, it is not to be run. */
export function parseSieve(text: string): SieveScript {
  const script: SieveScript = { commands: [], rules: [], problems: [] };
  let all: Token[];
  try {
    all = tokens(text);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    script.problems.push({ line: error.line, message: error.message });
    return script;
  }
  let at = 0;
  const required = new Set<string>();
  /** The name the last comment gave to what follows it. */
  let named: string | null = null;
  const last = all.at(-1)?.line ?? 1;

  // A comment may be come upon while looking ahead for what follows a command: the name it gives is kept for what comes next.
  const skip = () => {
    while (all[at]?.type === 'comment') {
      const mark = RULE_MARK.exec(all[at]?.value ?? '');
      if (mark) named = mark[1] ?? '';
      at++;
    }
  };
  const peek = (): Token | undefined => {
    skip();
    return all[at];
  };
  const fail = (message: string, token = all[at]): never => {
    throw new Refused(token?.line ?? last, message);
  };
  const punct = (value: string) => {
    const token = peek();
    if (token?.type !== 'punct' || token.value !== value) {
      fail(`“${value}” is expected here`, token ?? all[at - 1]);
    }
    at++;
  };
  const isPunct = (value: string) => {
    const token = peek();
    return token?.type === 'punct' && token.value === value;
  };
  const needs = (name: string, token: Token) => {
    const extension = NEEDS[name];
    if (extension && !required.has(extension)) {
      fail(`“${name}” needs: require "${extension}";`, token);
    }
  };
  const strings = (what: string): string[] => {
    const token = peek();
    if (token?.type === 'string') {
      at++;
      return [token.value];
    }
    if (token?.type === 'punct' && token.value === '[') {
      at++;
      const list: string[] = [];
      for (;;) {
        const one = peek();
        if (one?.type !== 'string') fail('Text in "…" is expected here', one);
        list.push((one as Token).value);
        at++;
        if (isPunct(',')) {
          at++;
          continue;
        }
        punct(']');
        return list;
      }
    }
    return fail(`${what} is expected here, in "…"`, token ?? all[at - 1]);
  };
  const one = (what: string): string => {
    const token = peek();
    if (token?.type !== 'string') {
      return fail(`${what} is expected here, in "…"`, token ?? all[at - 1]);
    }
    at++;
    return token.value;
  };
  const tags = (): Token[] => {
    const list: Token[] = [];
    while (peek()?.type === 'tag') list.push(all[at++] as Token);
    return list;
  };

  const test = (): SieveTest => {
    const token = peek();
    if (token?.type !== 'word') {
      return fail('A test is expected here', token ?? all[at - 1]);
    }
    at++;
    const kind = token.value;
    if (kind === 'true' || kind === 'false') return { kind };
    if (kind === 'not') return { kind, test: test() };
    if (kind === 'allof' || kind === 'anyof') {
      punct('(');
      const list = [test()];
      while (isPunct(',')) {
        at++;
        list.push(test());
      }
      punct(')');
      return { kind, tests: list };
    }
    if (kind === 'exists') return { kind, headers: strings('A header') };
    if (kind === 'size') {
      const [way] = tags();
      const limit = peek();
      if (
        (way?.value !== ':over' && way?.value !== ':under') ||
        limit?.type !== 'number'
      ) {
        return fail('size is followed by :over or :under and a number', token);
      }
      at++;
      return { kind, over: way.value === ':over', limit: limit.number };
    }
    if (kind === 'header' || kind === 'address') {
      let match: SieveMatch = 'is';
      let part: 'all' | 'localpart' | 'domain' = 'all';
      let exact = false;
      for (const tag of tags()) {
        const word = tag.value.slice(1);
        if (word === 'is' || word === 'contains' || word === 'matches') {
          match = word;
        } else if (
          kind === 'address' &&
          (word === 'all' || word === 'localpart' || word === 'domain')
        ) {
          part = word;
        } else if (word === 'comparator') {
          const name = one('A way to compare');
          if (name !== 'i;octet' && name !== 'i;ascii-casemap') {
            fail(`This server cannot compare by “${name}”`, tag);
          }
          exact = name === 'i;octet';
        } else {
          fail(`“${tag.value}” is not known for ${kind}`, tag);
        }
      }
      const headers = strings('A header');
      return {
        kind,
        match,
        part,
        exact,
        headers,
        keys: strings('What to find'),
      };
    }
    return fail(`“${kind}” is not a test this server knows`, token);
  };

  const block = (): SieveCommand[] => {
    punct('{');
    const list: SieveCommand[] = [];
    while (!isPunct('}')) {
      if (peek() === undefined) fail('A “{” is opened and not closed');
      list.push(command(false));
    }
    at++;
    return list;
  };

  const command = (top: boolean): SieveCommand => {
    const token = peek();
    if (token?.type !== 'word') {
      return fail('A command is expected here', token ?? all[at - 1]);
    }
    at++;
    const { line, value: kind } = token;
    needs(kind, token);
    if (kind === 'require') {
      if (!top || script.commands.some((each) => each.kind !== 'require')) {
        fail('require comes before everything else', token);
      }
      const names = strings('An extension');
      for (const name of names) {
        if (!EXTENSIONS.includes(name)) {
          fail(`This server does not have the extension “${name}”`, token);
        }
        required.add(name);
      }
      punct(';');
      return { kind, names, line };
    }
    if (kind === 'if') {
      const branches = [{ test: test(), block: block() }];
      let otherwise: SieveCommand[] | null = null;
      for (;;) {
        const next = peek();
        if (next?.type === 'word' && next.value === 'elsif') {
          at++;
          branches.push({ test: test(), block: block() });
        } else if (next?.type === 'word' && next.value === 'else') {
          at++;
          otherwise = block();
          break;
        } else break;
      }
      return { kind, branches, otherwise, line };
    }
    if (kind === 'stop' || kind === 'keep' || kind === 'discard') {
      punct(';');
      return { kind, line };
    }
    if (kind === 'fileinto') {
      let flags: string[] | null = null;
      let mailboxId: string | null = null;
      let copy = false;
      while (peek()?.type === 'tag') {
        const tag = all[at++] as Token;
        needs(tag.value, tag);
        if (tag.value === ':flags') flags = strings('A flag');
        else if (tag.value === ':mailboxid') mailboxId = one('A mailbox id');
        else if (tag.value === ':copy') copy = true;
        else fail(`“${tag.value}” is not known for fileinto`, tag);
      }
      const mailbox = one('A folder');
      punct(';');
      return { kind, mailbox, mailboxId, flags, copy, line };
    }
    if (kind === 'addflag' || kind === 'setflag' || kind === 'removeflag') {
      const flags = strings('A flag');
      punct(';');
      return { kind, flags, line };
    }
    if (kind === 'redirect') {
      return fail('Forwarding is not something this server does yet', token);
    }
    if (kind === 'elsif' || kind === 'else') {
      return fail(`“${kind}” comes after an if`, token);
    }
    return fail(`“${kind}” is not a command this server knows`, token);
  };

  try {
    for (;;) {
      skip();
      if (at >= all.length) break;
      const name: string | null = named;
      named = null;
      script.commands.push(command(true));
      script.rules.push(name);
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    script.problems.push({ line: error.line, message: error.message });
  }
  return script;
}

// ------------------------------------------------------------------ running

/** What a script is given of a message: its headers as written, unfolded and decoded, and how big it is. */
export interface SieveMessage {
  headers: ReadonlyArray<readonly [name: string, value: string]>;
  size: number;
}

/** Where one copy of a message goes, and with which flags. */
export interface SieveDelivery {
  /** The folder by name, as the script says it. Null for where it would go anyway. */
  mailbox: string | null;
  mailboxId: string | null;
  flags: string[];
}

/** What a script would do with a message. */
export interface SieveOutcome {
  /** Where it is kept: at least once, unless it is discarded. */
  deliveries: SieveDelivery[];
  /** Kept nowhere: the script said to throw it away. */
  discarded: boolean;
  /** The named filters that did something, in the order they did. */
  rules: string[];
}

function wildcard(key: string, exact: boolean): RegExp {
  let pattern = '';
  for (let at = 0; at < key.length; at++) {
    const letter = key[at] as string;
    if (letter === '\\' && at + 1 < key.length) {
      pattern += (key[++at] as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (letter === '*') pattern += '[\\s\\S]*';
    else if (letter === '?') pattern += '[\\s\\S]';
    else pattern += letter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`, exact ? '' : 'i');
}

function matches(
  value: string,
  key: string,
  match: SieveMatch,
  exact: boolean,
): boolean {
  if (match === 'matches') return wildcard(key, exact).test(value);
  const [a, b] = exact
    ? [value, key]
    : [value.toLowerCase(), key.toLowerCase()];
  return match === 'is' ? a === b : a.includes(b);
}

/** The addresses a header names. */
function addresses(value: string): string[] {
  return (
    value.match(/[^\s<>(),;:"]+@[^\s<>(),;:"]+/g)?.map((each) => each.trim()) ??
    []
  );
}

function holds(test: SieveTest, message: SieveMessage): boolean {
  switch (test.kind) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'not':
      return !holds(test.test, message);
    case 'allof':
      return test.tests.every((each) => holds(each, message));
    case 'anyof':
      return test.tests.some((each) => holds(each, message));
    case 'exists':
      return test.headers.every((header) =>
        message.headers.some(
          ([name]) => name.toLowerCase() === header.toLowerCase(),
        ),
      );
    case 'size':
      return test.over ? message.size > test.limit : message.size < test.limit;
    default: {
      const wanted = test.headers.map((header) => header.toLowerCase());
      const values = message.headers
        .filter(([name]) => wanted.includes(name.toLowerCase()))
        .flatMap(([, value]) => {
          if (test.kind === 'header') return [value.trim()];
          return addresses(value).map((address) => {
            const split = address.lastIndexOf('@');
            return test.part === 'localpart'
              ? address.slice(0, split)
              : test.part === 'domain'
                ? address.slice(split + 1)
                : address;
          });
        });
      return values.some((value) =>
        test.keys.some((key) => matches(value, key, test.match, test.exact)),
      );
    }
  }
}

/** What a script would do with a message. The script is one that was read without problems. */
export function runSieve(
  script: Pick<SieveScript, 'commands' | 'rules'>,
  message: SieveMessage,
): SieveOutcome {
  const deliveries: SieveDelivery[] = [];
  const rules: string[] = [];
  let flags: string[] = [];
  /** Kept where it would go anyway, unless something else was done with it. */
  let kept = true;
  let discarded = false;
  let stopped = false;
  /** Whether the filter being run has done anything. */
  let acted = false;

  const run = (commands: readonly SieveCommand[]) => {
    for (const command of commands) {
      if (stopped) return;
      switch (command.kind) {
        case 'require':
          break;
        case 'if': {
          const branch = command.branches.find((each) =>
            holds(each.test, message),
          );
          if (branch) run(branch.block);
          else if (command.otherwise) run(command.otherwise);
          break;
        }
        case 'stop':
          stopped = true;
          acted = true;
          break;
        case 'keep':
          kept = true;
          discarded = false;
          acted = true;
          break;
        case 'discard':
          kept = false;
          discarded = true;
          acted = true;
          break;
        case 'fileinto':
          deliveries.push({
            mailbox: command.mailbox,
            mailboxId: command.mailboxId,
            flags: [...(command.flags ?? flags)],
          });
          if (!command.copy) kept = false;
          discarded = false;
          acted = true;
          break;
        case 'setflag':
          flags = [...new Set(command.flags)];
          acted = true;
          break;
        case 'addflag':
          flags = [...new Set([...flags, ...command.flags])];
          acted = true;
          break;
        case 'removeflag':
          flags = flags.filter(
            (flag) =>
              !command.flags.some(
                (each) => each.toLowerCase() === flag.toLowerCase(),
              ),
          );
          acted = true;
          break;
      }
    }
  };

  script.commands.forEach((command, index) => {
    if (stopped) return;
    acted = false;
    run([command]);
    const name = script.rules[index];
    if (acted && name !== null && name !== undefined && !rules.includes(name)) {
      rules.push(name);
    }
  });
  if (kept) {
    deliveries.unshift({ mailbox: null, mailboxId: null, flags: [...flags] });
  }
  return {
    deliveries: discarded && deliveries.length === 0 ? [] : deliveries,
    discarded: discarded && deliveries.length === 0,
    rules,
  };
}

/** A name as a keyword says it: what a message a filter acted on is marked with. */
export function sieveRuleKeyword(name: string): string {
  // FNV-1a: short, the same everywhere, and enough to tell a person's filters apart.
  let hash = 0x811c9dc5;
  for (const letter of name.trim().toLowerCase()) {
    hash = Math.imul(hash ^ (letter.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return `mailless-filter-${hash.toString(16).padStart(8, '0')}`;
}
