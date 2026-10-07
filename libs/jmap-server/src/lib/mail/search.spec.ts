import {
  highlight,
  matchesSearch,
  parseSearch,
  searchable,
  words,
} from './search.js';

const found = (query: string, ...texts: string[]) =>
  matchesSearch(
    parseSearch(query),
    texts.map((text) => searchable(text)),
  );

describe('searchable text', () => {
  it('reduces text to lower-case words without accents or punctuation', () => {
    expect(searchable('Olá, MUNDO! Relatório_final (v2).pdf')).toBe(
      ' ola mundo relatorio final v2 pdf ',
    );
    expect(searchable('ﬁnance Ⅷ ＡＢＣ')).toBe(' finance viii abc ');
    expect(searchable('  \n\t ')).toBe(' ');
  });

  it('treats each character of an unspaced script as a word', () => {
    expect(searchable('東京タワーへ行く')).toBe(' 東 京 タ ワ ー へ 行 く ');
    expect(words('abc東京')).toMatchObject([
      { term: 'abc', start: 0, end: 3 },
      { term: '東', start: 3, end: 4 },
      { term: '京', start: 4, end: 5 },
    ]);
  });

  it('stops at the size limit on a word boundary', () => {
    const text = searchable('alpha beta gamma delta', 48);
    expect(text).toBe(' alpha beta ');
  });
});

describe('matching a search', () => {
  const text = 'The quarterly budget review is on Thursday. Café reservations!';

  it('needs every word, in any order, ignoring case and accents', () => {
    expect(found('budget thursday', text)).toBe(true);
    expect(found('THURSDAY Budget', text)).toBe(true);
    expect(found('cafe', text)).toBe(true);
    expect(found('budget friday', text)).toBe(false);
  });

  it('matches the beginning of words, but not their middle', () => {
    expect(found('quart', text)).toBe(true);
    expect(found('reserv thu', text)).toBe(true);
    expect(found('udget', text)).toBe(false);
  });

  it('matches quoted text as an exact phrase', () => {
    expect(found('"budget review"', text)).toBe(true);
    expect(found("'budget review'", text)).toBe(true);
    expect(found('"review budget"', text)).toBe(false);
    expect(found('"budget rev"', text)).toBe(false);
    expect(found('"quarterly budget" thursday', text)).toBe(true);
    // Punctuation between the words does not break a phrase.
    expect(found('"thursday cafe"', text)).toBe(true);
  });

  it('keeps the parts of an address or a file name together', () => {
    const address = 'Alice <alice.smith@example.org>';
    expect(found('alice.smith@example.org', address)).toBe(true);
    expect(found('smith@example', address)).toBe(true);
    expect(found('example.org', address)).toBe(true);
    expect(found('smith.alice@example.org', address)).toBe(false);
  });

  it('looks in every text given, but never across two of them', () => {
    expect(found('budget alice', 'budget meeting', 'from alice')).toBe(true);
    expect(found('"meeting from"', 'budget meeting', 'from alice')).toBe(false);
  });

  it('finds runs of characters in unspaced scripts', () => {
    expect(found('東京', '明日は東京タワーへ行く')).toBe(true);
    expect(found('京東', '明日は東京タワーへ行く')).toBe(false);
  });

  it('matches everything when there is nothing to look for', () => {
    expect(found('', text)).toBe(true);
    expect(found(' "" !!! ', text)).toBe(true);
  });
});

describe('highlighting', () => {
  it('marks every match and escapes the rest', () => {
    expect(
      highlight('Budget <draft> & "Q3" budgets', parseSearch('budget')),
    ).toBe(
      '<mark>Budget</mark> &lt;draft&gt; &amp; &quot;Q3&quot; <mark>budgets</mark>',
    );
    expect(highlight('Résumé for Zoë', parseSearch('resume zoe'))).toBe(
      '<mark>Résumé</mark> for <mark>Zoë</mark>',
    );
    expect(
      highlight('the budget review', parseSearch('"budget review" the')),
    ).toBe('<mark>the</mark> <mark>budget review</mark>');
  });

  it('returns null when nothing matches', () => {
    expect(highlight('Budget review', parseSearch('holiday'))).toBeNull();
    expect(highlight('Budget review', parseSearch(''))).toBeNull();
    expect(highlight('', parseSearch('budget'))).toBeNull();
  });

  it('cuts a long text to the part around the first match, within the limit', () => {
    const text = `${'Lorem ipsum dolor sit amet. '.repeat(40)}The überraschung party is planned. ${'Consectetur adipiscing elit. '.repeat(40)}`;
    const snippet = highlight(text, parseSearch('uberraschung'), 255) as string;
    expect(new TextEncoder().encode(snippet).length).toBeLessThanOrEqual(255);
    expect(snippet).toContain('<mark>überraschung</mark> party');
    // Starts at a word, a little before the match.
    expect(snippet.startsWith('amet. Lorem ipsum')).toBe(true);
    expect(snippet.indexOf('<mark>')).toBeLessThan(60);

    // Multi-byte text is cut between characters, never inside one.
    const wide = highlight(
      '😀'.repeat(100) + ' 東京 ' + '😀'.repeat(300),
      parseSearch('東京'),
      255,
    ) as string;
    expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(255);
    expect(wide).toContain('<mark>東京</mark>');
    expect(wide).not.toContain('�');
    // No surrogate is left without its other half.
    expect(wide).toBe(new TextDecoder().decode(new TextEncoder().encode(wide)));
  });
});
