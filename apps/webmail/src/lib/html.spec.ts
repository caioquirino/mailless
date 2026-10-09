import {
  hasQuotedHtml,
  splitQuotedText,
  hasRemoteImages,
  inlineImageIds,
  messageDocument,
  misleadingLink,
  textOfHtml,
} from './html';

const body = (page: string) =>
  new DOMParser().parseFromString(page, 'text/html').body;

describe('messageDocument', () => {
  it('takes out everything that could do something', () => {
    const page = messageDocument(
      [
        '<html><head><meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/a.css">',
        '<script>alert(1)</script><style>p{color:red}</style></head>',
        '<body onload="alert(2)"><p onclick="alert(3)">Hello</p>',
        '<iframe src="https://evil.example"></iframe><object data="x"></object>',
        '<form action="https://evil.example"><input name="password"></form>',
        '<a href="javascript:alert(4)">bad</a> <a href="https://example.com/">good</a>',
        '<img src="x" onerror="alert(5)" srcset="https://evil.example/a.png 2x">',
        '</body></html>',
      ].join(''),
      { images: false },
    );
    expect(page).not.toMatch(/alert\(/);
    expect(page).not.toMatch(/evil\.example/);
    expect(page).not.toMatch(/<script|<iframe|<object|refresh/i);
    // The message's own look is kept.
    expect(page).toContain('p{color:red}');
    expect(page).toContain('Hello');
    const links = [...body(page).querySelectorAll('a')];
    expect(links[0]?.hasAttribute('href')).toBe(false);
    expect(links[1]?.getAttribute('href')).toBe('https://example.com/');
    expect(links[1]?.getAttribute('target')).toBe('_blank');
    expect(links[1]?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('loads nothing from anywhere unless pictures are asked for', () => {
    const html = '<img src="https://tracker.example/open.gif">';
    const closed = messageDocument(html, { images: false });
    expect(closed).toContain("default-src 'none'; img-src data:;");
    const open = messageDocument(html, { images: true });
    expect(open).toContain('img-src data: https: http:;');
    expect(open).not.toMatch(/script-src/);
  });

  it('shows the pictures that came with the message', () => {
    const page = messageDocument(
      '<img src="cid:logo@example.com"><img src="cid:missing">',
      {
        images: false,
        inline: { 'logo@example.com': 'data:image/png;base64,AAAA' },
      },
    );
    const images = [...body(page).querySelectorAll('img')];
    expect(images[0]?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(images[1]?.hasAttribute('src')).toBe(false);
  });
});

describe('a link that is not what it shows', () => {
  it('is one that shows a site and leads to another', () => {
    expect(
      misleadingLink('https://evil.example/login', 'www.bank.example'),
    ).toBe('evil.example');
    expect(
      misleadingLink('https://evil.example/', 'https://bank.example/account'),
    ).toBe('evil.example');
    // The same site, a part of it, or words that are no address at all.
    expect(
      misleadingLink('https://www.bank.example/a', 'bank.example'),
    ).toBeNull();
    expect(
      misleadingLink('https://mail.bank.example/a', 'bank.example/login'),
    ).toBeNull();
    expect(misleadingLink('https://evil.example/', 'Click here')).toBeNull();
    expect(
      misleadingLink('mailto:ann@bank.example', 'other.example'),
    ).toBeNull();
  });

  it('is one whose site is written in look-alike letters', () => {
    expect(misleadingLink('https://xn--pple-43d.com/', 'Sign in')).toBe(
      'xn--pple-43d.com',
    );
  });

  it('is said beside the link, in the message', () => {
    const page = messageDocument(
      '<a href="https://evil.example/x">bank.example</a> and <a href="https://good.example/">good.example</a>',
      { images: false },
    );
    const [bad, good] = [...body(page).querySelectorAll('a')];
    expect(bad?.nextElementSibling?.textContent).toBe(
      ' [this link goes to evil.example]',
    );
    expect(bad?.getAttribute('title')).toBe('https://evil.example/x');
    expect(good?.nextElementSibling).toBeNull();
  });
});

describe('what a message refers to', () => {
  it('knows pictures kept elsewhere from those that came with it', () => {
    expect(hasRemoteImages('<img src="https://example.com/a.png">')).toBe(true);
    expect(hasRemoteImages('<td background="http://example.com/a.png">')).toBe(
      true,
    );
    expect(
      hasRemoteImages('<p style="background:url(//example.com/a.png)">'),
    ).toBe(true);
    expect(
      hasRemoteImages('<img src="cid:a"><a href="https://x.example">x</a>'),
    ).toBe(false);
    expect(inlineImageIds('<img src="cid:a%40b"> <img src=cid:c>')).toEqual([
      'a@b',
      'c',
    ]);
  });
});

describe('textOfHtml', () => {
  it('gives the words, a line for each paragraph', () => {
    expect(
      textOfHtml(
        '<style>p{}</style><p>One&nbsp;two</p><div>Three<br>Four</div><script>x()</script>',
      ),
    ).toBe('One two\nThree\nFour');
  });
});

describe('what a message quotes', () => {
  it('is told from what it says, in plain text', () => {
    expect(
      splitQuotedText(
        'Yes, Thursday.\n\nOn Mon, 5 Jan 2026, 09:00, Bob wrote:\n> Thursday?\n>> Earlier\n',
      ),
    ).toEqual({
      body: 'Yes, Thursday.',
      quoted: 'On Mon, 5 Jan 2026, 09:00, Bob wrote:\n> Thursday?\n>> Earlier',
    });
    // A name or a date long enough to break the line.
    expect(
      splitQuotedText(
        'Fine.\n\nOn Monday,\nBob <bob@example.com> wrote:\n> Hello',
      ).body,
    ).toBe('Fine.');
    // A quote in the middle, answered below, is part of what is said.
    expect(splitQuotedText('> Thursday?\n\nYes.').quoted).toBe('');
    // Nothing but a quote is shown as it is.
    expect(splitQuotedText('> Thursday?').quoted).toBe('');
    expect(splitQuotedText('Hello').quoted).toBe('');
  });

  it('is folded away in a message written in HTML, as each mail program marks it', () => {
    const gmail =
      '<div>Yes!</div><div class="gmail_quote"><div>On Mon, Bob wrote:</div><blockquote>Thursday?</blockquote></div>';
    expect(hasQuotedHtml(gmail)).toBe(true);
    const folded = messageDocument(gmail, { images: false, quoted: false });
    expect(folded).toContain('Yes!');
    expect(folded).not.toContain('Thursday?');
    expect(messageDocument(gmail, { images: false })).toContain('Thursday?');

    const thunderbird =
      '<p>Yes!</p><div class="moz-cite-prefix">On 05/01, Bob wrote:</div><blockquote type="cite">Thursday?</blockquote>';
    expect(
      messageDocument(thunderbird, { images: false, quoted: false }),
    ).not.toMatch(/Bob wrote|Thursday/);

    const outlook =
      '<p>Yes!</p><hr><div id="divRplyFwdMsg"><b>From:</b> Bob</div><div>Thursday?</div>';
    const outlookFolded = messageDocument(outlook, {
      images: false,
      quoted: false,
    });
    expect(outlookFolded).toContain('Yes!');
    expect(outlookFolded).not.toMatch(/From:|Thursday|<hr/);
  });

  it('is left alone when it is all there is, or is a message passed on', () => {
    const only = '<blockquote type="cite">Thursday?</blockquote>';
    expect(hasQuotedHtml(only)).toBe(false);
    expect(messageDocument(only, { images: false, quoted: false })).toContain(
      'Thursday?',
    );
    const forwarded =
      '<div>FYI</div><div class="gmail_quote">---------- Forwarded message ---------<br>From: Bob<br>Thursday?</div>';
    expect(hasQuotedHtml(forwarded)).toBe(false);
    expect(hasQuotedHtml('<p>Hello</p>')).toBe(false);
  });
});
