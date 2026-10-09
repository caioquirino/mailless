import type { Email, Identity } from '@mailless/jmap-core';
import {
  bodiesOf,
  laterChoices,
  emptyDraft,
  forwardDraft,
  linkAddress,
  listedAttachments,
  mailHtml,
  mentionsAttachment,
  plainOf,
  replyDraft,
  resumeDraft,
  textOf,
  wordsHtml,
} from './compose';

const identities = [
  { id: 'ann', name: 'Ann', email: 'ann@example.com' },
  { id: 'sales', name: 'Sales', email: 'sales@example.com' },
] as Identity[];

const email = (changes: Partial<Email> = {}): Email =>
  ({
    id: 'e1',
    threadId: 't1',
    subject: 'Lunch',
    receivedAt: '2026-01-05T09:00:00Z',
    from: [{ name: 'Bob', email: 'bob@example.com' }],
    to: [
      { name: 'Sales', email: 'sales@example.com' },
      { name: 'Carol', email: 'carol@example.com' },
    ],
    cc: [{ name: null, email: 'dan@example.com' }],
    replyTo: null,
    messageId: ['m1@example.com'],
    references: ['m0@example.com'],
    textBody: [{ partId: '1', type: 'text/plain' }],
    bodyValues: { '1': { value: 'Thursday?\n> Earlier\n' } },
    attachments: [
      { blobId: 'b1', name: 'menu.pdf', type: 'application/pdf', size: 10 },
    ],
    keywords: {},
    ...changes,
  }) as unknown as Email;

/** An address that would run something, which no link may be. */
const SCRIPT = ['java', 'script:alert(1)'].join('');

describe('replyDraft', () => {
  it('answers the sender, as whoever the message was written to', () => {
    const draft = replyDraft(email(), identities, false);
    expect(draft.identityId).toBe('sales');
    expect(draft.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe('Re: Lunch');
    expect(draft.inReplyTo).toEqual(['m1@example.com']);
    expect(draft.references).toEqual(['m0@example.com', 'm1@example.com']);
    expect(draft.html).toBe('');
    expect(draft.quote?.text).toMatch(
      /^On .* Bob wrote:\n> Thursday\?\n>> Earlier/,
    );
    expect(draft.quote?.html).toContain('<blockquote type="cite"');
    expect(draft.quote?.html).toContain('Thursday?');
    expect(draft.answers).toEqual({ emailId: 'e1', keyword: '$answered' });
    expect(draft.attachments).toEqual([]);
  });

  it('answers everyone but oneself, and where the sender asks to be answered', () => {
    const draft = replyDraft(
      email({
        subject: 'RE: Lunch',
        replyTo: [{ name: null, email: 'list@example.com' }],
      }),
      identities,
      true,
    );
    expect(draft.to).toEqual([{ name: null, email: 'list@example.com' }]);
    expect(draft.cc.map((address) => address.email)).toEqual([
      'carol@example.com',
      'dan@example.com',
    ]);
    expect(draft.subject).toBe('RE: Lunch');
  });

  it('answers what one sent oneself to whoever it was sent to', () => {
    const draft = replyDraft(
      email({
        from: [{ name: 'Ann', email: 'ann@example.com' }],
        to: [{ name: 'Bob', email: 'bob@example.com' }],
        cc: null,
      }),
      identities,
      true,
    );
    expect(draft.identityId).toBe('ann');
    expect(draft.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(draft.cc).toEqual([]);
  });
});

describe('forwardDraft', () => {
  it('passes on what was said and what came with it', () => {
    const draft = forwardDraft(email(), identities);
    expect(draft.to).toEqual([]);
    expect(draft.subject).toBe('Fwd: Lunch');
    expect(draft.quote?.text).toContain('Forwarded message');
    expect(draft.quote?.text).toContain('From: Bob <bob@example.com>');
    expect(draft.quote?.text).toContain('Thursday?');
    expect(draft.quote?.html).toContain('From: Bob &lt;bob@example.com&gt;');
    expect(draft.attachments).toEqual([
      { blobId: 'b1', name: 'menu.pdf', type: 'application/pdf', size: 10 },
    ]);
    expect(draft.answers?.keyword).toBe('$forwarded');
    expect(draft.inReplyTo).toBeUndefined();
  });
});

describe('resumeDraft', () => {
  it('goes on with a kept draft, which the next copy replaces', () => {
    const draft = resumeDraft(
      email({
        from: [{ name: 'Sales', email: 'sales@example.com' }],
        to: [{ name: 'Bob', email: 'bob@example.com' }],
        cc: null,
        inReplyTo: ['m0@example.com'],
      }),
      identities,
    );
    expect(draft).toMatchObject({
      identityId: 'sales',
      to: [{ name: 'Bob', email: 'bob@example.com' }],
      cc: [],
      subject: 'Lunch',
      html: '<p>Thursday?</p><p>&gt; Earlier</p>',
      unsigned: true,
      replaces: 'e1',
      inReplyTo: ['m0@example.com'],
    });
  });

  it('takes a draft of its own apart again: the words, and what they answer', () => {
    const sales = { ...identities[1], textSignature: 'The sales team' };
    const reply = {
      ...replyDraft(email(), identities, false),
      html: '<p>Yes, <b>Thursday</b>.</p>',
    };
    const bodies = bodiesOf(reply, sales as Identity);
    const draft = resumeDraft(
      email({
        from: [{ name: 'Sales', email: 'sales@example.com' }],
        textBody: [{ partId: '1', type: 'text/plain' }],
        htmlBody: [{ partId: '2', type: 'text/html' }],
        bodyValues: {
          '1': { value: bodies.text },
          '2': { value: bodies.html },
        },
      } as unknown as Partial<Email>),
      identities,
    );
    expect(draft.html).toBe('<p style="margin:0">Yes, <b>Thursday</b>.</p>');
    expect(draft.unsigned).toBeUndefined();
    expect(draft.quote?.text).toBe(reply.quote?.text);
    expect(draft.quote?.html).toContain('<blockquote type="cite"');
    // Kept and opened any number of times, it is signed once.
    expect(bodiesOf(draft, sales as Identity).text).toBe(bodies.text);
  });
});

describe('the pictures of what is answered or passed on', () => {
  const pictured = () =>
    email({
      htmlBody: [{ partId: '1', type: 'text/html' }],
      bodyValues: {
        '1': { value: '<p>Look</p><img src="cid:photo@example.com">' },
      },
      attachments: [
        { blobId: 'b1', name: 'menu.pdf', type: 'application/pdf', size: 10 },
        {
          blobId: 'b2',
          name: 'photo.png',
          type: 'image/png',
          size: 5,
          cid: 'photo@example.com',
        },
      ],
    } as unknown as Partial<Email>);

  it('go along with an answer, which quotes them in place', () => {
    const draft = replyDraft(pictured(), identities, false);
    expect(draft.quote?.html).toContain('src="cid:photo@example.com"');
    expect(draft.pictures).toEqual([
      {
        cid: 'photo@example.com',
        blobId: 'b2',
        name: 'photo.png',
        type: 'image/png',
        size: 5,
      },
    ]);
    expect(draft.attachments).toEqual([]);
  });

  it('are passed on in place, and the files beside them as files', () => {
    const draft = forwardDraft(pictured(), identities);
    expect(draft.pictures?.map((each) => each.name)).toEqual(['photo.png']);
    expect(draft.attachments.map((each) => each.name)).toEqual(['menu.pdf']);
  });
});

describe('listedAttachments', () => {
  it('leaves out the pictures the words show in place', () => {
    const listed = listedAttachments(
      email({
        htmlBody: [{ partId: '1', type: 'text/html' }],
        bodyValues: { '1': { value: '<img src="cid:logo@example.com">' } },
        attachments: [
          { blobId: 'b1', name: 'menu.pdf', type: 'application/pdf', size: 10 },
          {
            blobId: 'b2',
            name: 'logo.png',
            type: 'image/png',
            size: 5,
            cid: 'logo@example.com',
          },
          // Given an id by the program that sent it, and shown nowhere in the words.
          {
            blobId: 'b3',
            name: 'scan.png',
            type: 'image/png',
            size: 5,
            cid: 'x',
          },
        ],
      } as unknown as Partial<Email>),
    );
    expect(listed.map((each) => each.name)).toEqual(['menu.pdf', 'scan.png']);
  });
});

describe('textOf', () => {
  it('reads the words of a message written only in HTML', () => {
    expect(
      textOf(
        email({
          textBody: [{ partId: '1', type: 'text/html' }],
          bodyValues: { '1': { value: '<p>Hello <b>there</b></p>' } },
        } as unknown as Partial<Email>),
      ),
    ).toBe('Hello there');
  });
});

describe('what the editor writes', () => {
  const written =
    '<p dir="auto"><span style="white-space: pre-wrap;">Hello  Bob,</span></p>' +
    '<p><br></p>' +
    '<ul><li value="1"><span>one</span></li><li value="2"><b><strong class="x">two</strong></b></li></ul>' +
    '<blockquote><span>said before</span></blockquote>' +
    '<p><span>See </span><a href="https://example.com/a" class="l"><span>the page</span></a><span> or </span><a href="https://example.com"><span>example.com</span></a></p>';

  it('goes into a message without the editor\u2019s own marks', () => {
    const html = mailHtml(written);
    expect(html).not.toMatch(/class=|dir=|<span|pre-wrap/);
    expect(html).toContain('<p style="margin:0">Hello &nbsp;Bob,</p>');
    expect(html).toContain('<li value="2"><b><strong>two</strong></b></li>');
    expect(html).toContain('<a href="https://example.com/a">the page</a>');
    expect(html).toMatch(/<blockquote style="[^"]*border-left/);
  });

  it('keeps a picture that goes with the message, and no other', () => {
    const html = mailHtml(
      '<p><img src="cid:a@mailless" alt="plan.png" width="240" class="x" onerror="x()"><img src="https://example.com/far.png"></p>',
    );
    expect(html).toBe(
      '<p style="margin:0"><img src="cid:a@mailless" alt="plan.png" width="240" style="max-width:100%;height:auto"></p>',
    );
  });

  it('reads as plain words too', () => {
    expect(plainOf(written)).toBe(
      [
        'Hello  Bob,',
        '',
        '- one',
        '- two',
        '> said before',
        'See the page <https://example.com/a> or example.com',
      ].join('\n'),
    );
    expect(plainOf('<p><br></p>')).toBe('');
  });

  it('starts from plain words, a paragraph to a line', () => {
    expect(wordsHtml('a <b>\n\nc')).toBe(
      '<p>a &lt;b&gt;</p><p><br></p><p>c</p>',
    );
    expect(plainOf(wordsHtml('a <b>\n\nc'))).toBe('a <b>\n\nc');
  });

  it('knows a link from what is not one', () => {
    expect(linkAddress('example.com/a')).toBe('https://example.com/a');
    expect(linkAddress(' https://example.com ')).toBe('https://example.com');
    expect(linkAddress('bob@example.com')).toBe('mailto:bob@example.com');
    expect(linkAddress(SCRIPT)).toBeNull();
    expect(linkAddress('not a link')).toBeNull();
  });

  it('notices words about something attached', () => {
    expect(mentionsAttachment('<p>The notes are attached.</p>')).toBe(true);
    expect(mentionsAttachment('<p>See you Thursday.</p>')).toBe(false);
  });
});

describe('signatures', () => {
  const ann = {
    ...identities[0],
    textSignature: 'Ann Lee\nExample <Ltd>',
  } as Identity;
  const plain = identities[0] as Identity;
  const hello = { ...emptyDraft([ann]), html: '<p>Hello Bob,</p>' };

  it('end a message, under the line mail programs know them by', () => {
    const bodies = bodiesOf(hello, ann);
    expect(bodies.text).toBe('Hello Bob,\n\n-- \nAnn Lee\nExample <Ltd>');
    expect(bodies.html).toContain(
      '<div class="mailless-words"><p style="margin:0">Hello Bob,</p></div>',
    );
    expect(bodies.html).toMatch(
      /<div class="mailless-signature"[^>]*>-- <br>Ann Lee<br>Example &lt;Ltd&gt;<\/div>/,
    );
    expect(bodiesOf(hello, plain).text).toBe('Hello Bob,');
    expect(bodiesOf(hello, plain).html).not.toContain('mailless-signature');
  });

  it('go above what an answer quotes', () => {
    const reply = { ...replyDraft(email(), [ann], false), html: '<p>Yes.</p>' };
    const bodies = bodiesOf(reply, ann);
    expect(bodies.text).toMatch(
      /^Yes\.\n\n-- \nAnn Lee\nExample <Ltd>\n\nOn .* Bob wrote:\n> Thursday\?/,
    );
    expect(bodies.html.indexOf('mailless-signature')).toBeLessThan(
      bodies.html.indexOf('mailless-quote'),
    );
  });

  it('are left off a draft from elsewhere, which has its own', () => {
    expect(bodiesOf({ ...hello, unsigned: true }, ann).text).toBe('Hello Bob,');
  });
});

describe('laterChoices', () => {
  const names = (now: string) =>
    laterChoices(new Date(now)).map(
      (choice) =>
        `${choice.label}: ${choice.at.getDate()} at ${choice.at.getHours()}`,
    );

  it('offers the next moments a person would name', () => {
    // A Friday morning.
    expect(names('2026-10-09T09:30:00')).toEqual([
      'In one hour: 9 at 10',
      'This afternoon: 9 at 16',
      'Tomorrow morning: 10 at 8',
      'Monday morning: 12 at 8',
    ]);
  });

  it('leaves out the afternoon once it is here, and Monday when it is tomorrow', () => {
    // A Sunday evening.
    expect(names('2026-10-11T18:00:00')).toEqual([
      'In one hour: 11 at 19',
      'Tomorrow morning: 12 at 8',
    ]);
    // A Monday: the one after.
    expect(names('2026-10-12T18:00:00')).toContain('Monday morning: 19 at 8');
  });
});
