import type { Email, Identity } from '@mailless/jmap-core';
import {
  emptyDraft,
  forwardDraft,
  replyDraft,
  resumeDraft,
  swapSignature,
  textOf,
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

describe('replyDraft', () => {
  it('answers the sender, as whoever the message was written to', () => {
    const draft = replyDraft(email(), identities, false);
    expect(draft.identityId).toBe('sales');
    expect(draft.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe('Re: Lunch');
    expect(draft.inReplyTo).toEqual(['m1@example.com']);
    expect(draft.references).toEqual(['m0@example.com', 'm1@example.com']);
    expect(draft.text).toContain('Bob wrote:\n> Thursday?\n>> Earlier');
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
    expect(draft.text).toContain('Forwarded message');
    expect(draft.text).toContain('From: Bob <bob@example.com>');
    expect(draft.text).toContain('Thursday?');
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
      text: 'Thursday?\n> Earlier',
      replaces: 'e1',
      inReplyTo: ['m0@example.com'],
    });
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

describe('signatures', () => {
  const ann = {
    ...identities[0],
    textSignature: 'Ann Lee\nExample Ltd',
  } as Identity;
  const sales = {
    ...identities[1],
    textSignature: 'The sales team',
  } as Identity;
  const plain = identities[0] as Identity;

  it('end a new message, under the line mail programs know them by', () => {
    expect(emptyDraft([ann]).text).toBe('\n\n-- \nAnn Lee\nExample Ltd');
    expect(emptyDraft([plain]).text).toBe('');
  });

  it('go above what an answer quotes, and above what is passed on', () => {
    const reply = replyDraft(email(), [ann, sales], false);
    // Written to the sales address, so signed as sales.
    expect(reply.text).toMatch(
      /^\n\n-- \nThe sales team\n\nOn .* Bob wrote:\n> Thursday\?/,
    );
    expect(forwardDraft(email(), [ann, sales]).text).toMatch(
      /^\n\n-- \nThe sales team\n\n-{10} Forwarded message/,
    );
  });

  it('change with who the message is from', () => {
    const written = 'Hello Bob,\n\n-- \nAnn Lee\nExample Ltd';
    expect(swapSignature(written, ann, sales)).toBe(
      'Hello Bob,\n\n-- \nThe sales team',
    );
    expect(swapSignature(written, ann, plain)).toBe('Hello Bob,');
    expect(swapSignature('Hello Bob,', plain, ann)).toBe(
      'Hello Bob,\n\n-- \nAnn Lee\nExample Ltd\n',
    );
    // Taken out by hand: it is not put back by changing nothing.
    expect(swapSignature('Hello Bob,', ann, ann)).toBe('Hello Bob,');
  });
});
