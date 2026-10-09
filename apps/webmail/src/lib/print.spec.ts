import type { Email } from '@mailless/jmap-core';
import { printablePage } from './print';

const email = {
  subject: 'Photos <1>',
  receivedAt: '2026-01-05T09:00:00Z',
  from: [{ name: 'Bob', email: 'bob@example.com' }],
  to: [{ name: null, email: 'ann@example.com' }],
  htmlBody: [{ partId: '1', type: 'text/html' }],
  bodyValues: {
    '1': {
      value:
        '<p>Look</p><img src="https://example.com/far.png"><img src="cid:near@example.com"><script>alert(1)</script>',
    },
  },
} as unknown as Email;

describe('a message to print', () => {
  it('says who wrote it, when and what about, above what it says', () => {
    const page = printablePage(email, { images: false, inline: {} });
    expect(page).toContain('Photos &lt;1&gt;');
    expect(page).toContain('<b>From:</b> Bob &lt;bob@example.com&gt;');
    expect(page).toContain('<p>Look</p>');
    expect(page).not.toContain('alert(1)');
  });

  it('has the pictures the screen has, and fetches no others', () => {
    const hidden = printablePage(email, { images: false, inline: {} });
    expect(hidden).toContain('img-src data:;');
    const embedded = printablePage(email, {
      images: false,
      inline: { 'near@example.com': 'data:image/png;base64,AAAA' },
    });
    // What came with the message is printed whether or not the others are shown.
    expect(embedded).toContain('src="data:image/png;base64,AAAA"');
    expect(embedded).toContain('img-src data:;');
    const shown = printablePage(email, { images: true, inline: {} });
    expect(shown).toContain('img-src data: https: http:;');
  });
});
