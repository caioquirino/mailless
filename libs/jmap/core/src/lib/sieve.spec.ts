import { parseSieve, runSieve, sieveRuleKeyword } from './sieve.js';

const message = (headers: Record<string, string>, size = 1000) => ({
  headers: Object.entries(headers),
  size,
});

const SCRIPT = `require ["fileinto", "imap4flags", "mailboxid"];

# rule:[Invoices]
if anyof (address :contains "from" "nordlys.example",
          header :contains "subject" "invoice") {
    fileinto :flags "receipts" :mailboxid "mb1" "Invoices";
}

# rule:[Newsletters]
if exists "list-id" {
    addflag "\\\\Seen";
    fileinto "Reading";
    stop;
}

# rule:[Big]
if size :over 1M { addflag "$flagged"; }
`;

describe('parseSieve', () => {
  it('reads a script, and names the filters in it', () => {
    const script = parseSieve(SCRIPT);
    expect(script.problems).toEqual([]);
    expect(script.rules).toEqual([null, 'Invoices', 'Newsletters', 'Big']);
  });

  it.each([
    ['if true { fileinto "A"; }', 1, /require "fileinto"/],
    ['require "vacation";', 1, /does not have the extension/],
    ['require "fileinto";\nif true {\n  fileinto "A"\n}', 4, /“;” is expected/],
    ['if header :regex "a" "b" { keep; }', 1, /not known for header/],
    ['keep;\nrequire "fileinto";', 2, /before everything else/],
    ['redirect "a@example.com";', 1, /Forwarding/],
    ['if true { keep;', 1, /not closed/],
    ['fly;', 1, /not a command/],
    ['if header "a" "b', 1, /not closed/],
  ])('says what is wrong with %j, and where', (text, line, said) => {
    const [problem] = parseSieve(text).problems;
    expect(problem?.line).toBe(line);
    expect(problem?.message).toMatch(said);
  });
});

describe('runSieve', () => {
  const script = parseSieve(SCRIPT);

  it('keeps a message where it would go when nothing fits', () => {
    expect(
      runSieve(script, message({ From: 'Ann <ann@example.com>' })),
    ).toEqual({
      deliveries: [{ mailbox: null, mailboxId: null, flags: [] }],
      discarded: false,
      rules: [],
    });
  });

  it('files a message, with flags, and says which filter did', () => {
    expect(
      runSieve(
        script,
        message({ From: 'Billing <billing@NORDLYS.example>', Subject: 'Hi' }),
      ),
    ).toEqual({
      deliveries: [
        { mailbox: 'Invoices', mailboxId: 'mb1', flags: ['receipts'] },
      ],
      discarded: false,
      rules: ['Invoices'],
    });
  });

  it('goes on to the next filter, until one says to stop', () => {
    const outcome = runSieve(
      script,
      message(
        { Subject: 'Your invoice', 'List-Id': '<news.example>' },
        5_000_000,
      ),
    );
    expect(outcome.deliveries.map((each) => each.mailbox)).toEqual([
      'Invoices',
      'Reading',
    ]);
    expect(outcome.deliveries[1]?.flags).toEqual(['\\Seen']);
    // Stopped before the third.
    expect(outcome.rules).toEqual(['Invoices', 'Newsletters']);
  });

  it('flags a message that stays where it is', () => {
    expect(runSieve(script, message({}, 2_000_000))).toEqual({
      deliveries: [{ mailbox: null, mailboxId: null, flags: ['$flagged'] }],
      discarded: false,
      rules: ['Big'],
    });
  });

  it('matches by part of an address, by wildcard, and letter for letter', () => {
    const run = (text: string, headers: Record<string, string>) =>
      runSieve(parseSieve(`${text} { discard; }`), message(headers)).discarded;
    const from = { From: '"Ann, B." <Ann.B@Example.COM>' };
    expect(run('if address :domain :is "from" "example.com"', from)).toBe(true);
    expect(run('if address :localpart :is "from" "ann.b"', from)).toBe(true);
    expect(run('if address :is "from" "ann.b@example.org"', from)).toBe(false);
    expect(
      run('if header :matches "subject" "*re?eipt*"', {
        Subject: 'A Receipt!',
      }),
    ).toBe(true);
    expect(
      run('if header :comparator "i;octet" :contains "subject" "receipt"', {
        Subject: 'A Receipt!',
      }),
    ).toBe(false);
    expect(run('if not exists ["from", "date"]', from)).toBe(true);
    expect(run('if allof (true, not false, size :under 2K)', {})).toBe(true);
  });

  it('keeps a copy when told to, and throws away only what is filed nowhere', () => {
    const copy = parseSieve(
      'require ["fileinto", "copy"];\nfileinto :copy "A";',
    );
    expect(
      runSieve(copy, message({})).deliveries.map((d) => d.mailbox),
    ).toEqual([null, 'A']);
    const both = parseSieve('require "fileinto";\ndiscard;\nfileinto "A";');
    expect(runSieve(both, message({}))).toMatchObject({
      discarded: false,
      deliveries: [{ mailbox: 'A' }],
    });
    expect(runSieve(parseSieve('discard;'), message({}))).toEqual({
      deliveries: [],
      discarded: true,
      rules: [],
    });
  });
});

describe('sieveRuleKeyword', () => {
  it('is the same for a name however it is written, and a keyword', () => {
    expect(sieveRuleKeyword(' Invoices ')).toBe(sieveRuleKeyword('invoices'));
    expect(sieveRuleKeyword('Invoices')).toMatch(
      /^mailless-filter-[0-9a-f]{8}$/,
    );
    expect(sieveRuleKeyword('Invoices')).not.toBe(sieveRuleKeyword('Invoice'));
  });
});
