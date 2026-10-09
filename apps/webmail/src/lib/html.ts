/*
 * A message written in HTML is somebody else's page, and is shown as one: in
 * a frame of its own where no script runs, cut down first to what a message
 * needs. Three things each stop a message from doing anything but be read:
 *
 * - what is taken out here (scripts, frames, forms' targets, event handlers);
 * - the frame's sandbox, which runs no script whatever is left in;
 * - the policy written into the framed page, under which nothing is loaded
 *   from anywhere unless the reader asks to see the pictures.
 */

const REMOVED = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'meta',
  'base',
  'link',
  'title',
  'template',
  'portal',
].join(',');

/** Addresses a link may lead to. Anything else is not a link. */
const LINK = /^(https?:|mailto:|tel:|#)/i;

export interface MessageDocumentOptions {
  /** Whether pictures kept on other sites are loaded. Loading one tells its sender the message was opened. */
  images: boolean;
  /** The pictures that came with the message, by content id, as `data:` addresses. */
  inline?: Readonly<Record<string, string>>;
  /** Whether what the message quotes of earlier ones is shown. It is, unless told otherwise. */
  quoted?: boolean;
}

/** What mail programs wrap an earlier message in when answering it. */
const QUOTE = [
  '.gmail_quote',
  '.gmail_extra',
  'blockquote[type="cite"]',
  '.moz-cite-prefix',
  '.yahoo_quoted',
  '#divRplyFwdMsg',
  '#appendonsend',
  '.protonmail_quote',
  '.mailless-quote',
].join(',');

/** A message passed on is what the message is about, not something it quotes. */
const FORWARDED = /^\s*(-{2,}\s*)?(forwarded|original) message/i;

/**
 * Takes what a message quotes of earlier ones out of a parsed page. True
 * when something was taken out and something is left: a message that is
 * nothing but a quote is shown as it is.
 */
function removeQuoted(parsed: Document): boolean {
  const first = parsed.querySelector(QUOTE);
  if (!first || FORWARDED.test(first.textContent ?? '')) return false;
  const removed: Element[] = [];
  // Outlook marks where the quote starts, and everything after it is the quote.
  const toTheEnd = first.id === 'divRplyFwdMsg' || first.id === 'appendonsend';
  for (const element of [...parsed.querySelectorAll(QUOTE)]) {
    if (removed.some((other) => other.contains(element))) continue;
    removed.push(element);
    // The line that says who wrote it is followed by what they wrote.
    const next = element.nextElementSibling;
    if (element.matches('.moz-cite-prefix') && next?.tagName === 'BLOCKQUOTE') {
      removed.push(next);
    }
  }
  if (toTheEnd) {
    const rule = first.previousElementSibling;
    if (rule?.tagName === 'HR') removed.push(rule);
    for (let next = first.nextSibling; next; next = next.nextSibling) {
      if (next.nodeType === 1) removed.push(next as Element);
    }
  }
  // What would be left, worked out on a copy before anything is taken out.
  for (const element of removed) element.setAttribute('data-quoted', '');
  const kept = parsed.body.cloneNode(true) as HTMLElement;
  for (const element of removed) element.removeAttribute('data-quoted');
  for (const copy of [...kept.querySelectorAll('[data-quoted]')]) copy.remove();
  if ((kept.textContent ?? '').trim() === '' && !kept.querySelector('img')) {
    return false;
  }
  for (const element of removed) element.remove();
  return true;
}

/** Whether a message quotes earlier ones, in a way that can be folded away. */
export function hasQuotedHtml(html: string): boolean {
  return removeQuoted(new DOMParser().parseFromString(html, 'text/html'));
}

/**
 * A message written as plain text, apart from what it quotes of earlier
 * ones at its end: the lines that start with ">", and the line before them
 * that says who wrote them. `quoted` is empty when it quotes nothing there,
 * or is nothing but a quote.
 */
export function splitQuotedText(text: string): {
  body: string;
  quoted: string;
} {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = lines.length;
  let seen = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] as string;
    if (line.startsWith('>')) {
      start = index;
      seen = true;
    } else if (line.trim() !== '') {
      break;
    }
  }
  if (!seen) return { body: text, quoted: '' };
  // "On Monday, Bob wrote:", which a long name or date breaks over two lines.
  for (let back = 1; back <= 3 && start - back >= 0; back++) {
    const candidate = lines
      .slice(start - back, start)
      .join(' ')
      .trim();
    if (candidate === '') continue;
    if (!/:$/.test(candidate) || candidate.length >= 200) break;
    start -= back;
    const above = (lines[start - 1] ?? '').trim();
    if (above !== '' && !/^On\b/i.test(candidate) && /^On\b/i.test(above)) {
      start -= 1;
    }
    break;
  }
  const body = lines.slice(0, start).join('\n').trimEnd();
  if (body.trim() === '') return { body: text, quoted: '' };
  return { body, quoted: lines.slice(start).join('\n').trim() };
}

/** Whether a message refers to pictures kept on other sites. */
export function hasRemoteImages(html: string): boolean {
  return (
    /<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html) ||
    /url\(\s*["']?\s*(https?:)?\/\//i.test(html) ||
    /\bbackground\s*=\s*["']?\s*https?:/i.test(html)
  );
}

/** The content ids a message's pictures refer to. */
export function inlineImageIds(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(/\bcid:([^"'\s)>]+)/gi)) {
    ids.add(decodeURIComponent(match[1] as string));
  }
  return [...ids];
}

function contentId(address: string): string | null {
  const match = /^cid:(.+)$/i.exec(address.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return match[1] as string;
  }
}

/**
 * A message's HTML with nothing in it that acts: for putting inside another
 * message, as what an answer quotes. It is still somebody else's page, and
 * is only ever shown in a frame.
 */
export function quotableHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const element of [...parsed.querySelectorAll(`${REMOVED},style`)]) {
    element.remove();
  }
  for (const element of [...parsed.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const unsafe =
        name.startsWith('on') ||
        name === 'srcdoc' ||
        name === 'formaction' ||
        (name === 'action' && element.tagName === 'FORM') ||
        (name === 'href' && !LINK.test(attribute.value.trim()));
      if (unsafe) element.removeAttribute(attribute.name);
    }
  }
  return parsed.body.innerHTML;
}

/** The page to put in the frame for a message's HTML. */
export function messageDocument(
  html: string,
  options: MessageDocumentOptions,
): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const element of [...parsed.querySelectorAll(REMOVED)]) element.remove();
  if (options.quoted === false) removeQuoted(parsed);

  for (const element of [...parsed.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === 'A' || element.tagName === 'AREA') {
      const href = element.getAttribute('href');
      if (href !== null && !LINK.test(href.trim())) {
        element.removeAttribute('href');
      } else if (href !== null && !href.trim().startsWith('#')) {
        // Links open beside the mail, and say nothing of where they were followed from.
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (element.tagName === 'FORM') element.removeAttribute('action');
    if (element.tagName === 'IMG') {
      const id = contentId(element.getAttribute('src') ?? '');
      if (id !== null) {
        const data = options.inline?.[id];
        if (data) element.setAttribute('src', data);
        else element.removeAttribute('src');
      }
      element.removeAttribute('srcset');
    }
  }

  const styles = [...parsed.querySelectorAll('head style')]
    .map((style) => style.outerHTML)
    .join('');
  const policy = [
    "default-src 'none'",
    `img-src data:${options.images ? ' https: http:' : ''}`,
    "style-src 'unsafe-inline'",
    'font-src data:',
  ].join('; ');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light">',
    '<base target="_blank">',
    '<style>',
    'html{background:#fff;color:#1c2330;}',
    "body{margin:0;padding:4px 2px;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;overflow-wrap:anywhere;}",
    'img{max-width:100%;height:auto;}',
    'table{max-width:100%;}',
    'pre{white-space:pre-wrap;}',
    'blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:2px solid #c3c9d4;color:#5d6676;}',
    '</style>',
    styles,
    '</head><body>',
    parsed.body.innerHTML,
    '</body></html>',
  ].join('');
}

/** The words of an HTML message, for quoting it in an answer. */
export function textOfHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const element of [...parsed.querySelectorAll('script,style,head')]) {
    element.remove();
  }
  for (const element of [...parsed.querySelectorAll('br')]) {
    element.replaceWith('\n');
  }
  for (const element of [
    ...parsed.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote'),
  ]) {
    element.append('\n');
  }
  return (parsed.body.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
