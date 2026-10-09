import type { Email } from '@mailless/jmap-core';
import { formatAddresses } from './addresses';
import { escaped } from './compose';
import { formatFull } from './format';
import { messageDocument } from './html';

/** Which pictures of a message are on the screen, so that the same ones are printed. */
export interface PicturesShown {
  /** Whether pictures kept on other sites are shown. */
  images: boolean;
  /** The pictures that came with the message, by content id, as `data:` addresses. */
  inline: Readonly<Record<string, string>>;
}

/**
 * One message as a page to print: who, when and what about, then what it
 * says, with the pictures that are on the screen and no others. Printing
 * never fetches from a sender what the reader has not asked to see.
 */
export function printablePage(email: Email, shown: PicturesShown): string {
  const lines: Array<[string, string]> = [
    ['From', formatAddresses(email.from)],
    ['Date', formatFull(email.receivedAt)],
    ['To', formatAddresses(email.to)],
    ['Cc', formatAddresses(email.cc)],
  ];
  const head = [
    '<div style="font:14px/1.5 system-ui,sans-serif;color:#18202b">',
    `<h1 style="margin:0 0 8px;font-size:20px">${escaped(email.subject || '(no subject)')}</h1>`,
    ...lines
      .filter(([, value]) => value !== '')
      .map(([name, value]) => `<div><b>${name}:</b> ${escaped(value)}</div>`),
    '</div><hr style="margin:12px 0;border:0;border-top:1px solid #c3c9d4">',
  ].join('');
  const values = email.bodyValues ?? {};
  const body = (email.htmlBody ?? [])
    .map((part) => {
      const value = part.partId ? (values[part.partId]?.value ?? '') : '';
      return part.type === 'text/html'
        ? value
        : `<div style="white-space:pre-wrap">${escaped(value)}</div>`;
    })
    .join('');
  // Cut down like any message that is shown: nothing in it runs.
  return messageDocument(head + body, {
    images: shown.images,
    inline: shown.inline,
  });
}

/**
 * Prints one message by itself. It is put in a frame nobody sees, where no
 * script runs, and the browser is asked to print that frame.
 */
export function printMessage(email: Email, shown: PicturesShown): void {
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.srcdoc = printablePage(email, shown);
  frame.addEventListener('load', () => {
    const page = frame.contentWindow;
    if (!page) return;
    page.addEventListener('afterprint', () => frame.remove());
    page.focus();
    page.print();
  });
  document.body.append(frame);
  // Not every browser says when printing is over.
  window.setTimeout(() => frame.remove(), 10 * 60_000);
}
