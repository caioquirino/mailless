import type { SchedulingMessage } from '@mailless/jmap-calendars';

/*
 * An event on its way to someone else's calendar, as a message (RFC 6047):
 * words for whoever reads it as mail, the event itself for a program that
 * keeps a calendar, and the same again as a file, which is what some
 * programs look for.
 */

const encoder = new TextEncoder();

function base64(text: string): string {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 in lines a mail server has to accept. */
const wrapped = (text: string) =>
  (base64(text).match(/.{1,76}/g) ?? []).join('\r\n');

/** Words for a header: as they are when plain, and as encoded words when not (RFC 2047). */
function headerText(text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let part = '';
  for (const letter of clean) {
    // An encoded word is at most 75 letters, and may not part a letter in two.
    if (encoder.encode(part + letter).length > 39) {
      words.push(part);
      part = '';
    }
    part += letter;
  }
  if (part) words.push(part);
  return words.map((word) => `=?utf-8?B?${base64(word)}?=`).join('\r\n ');
}

function mailbox(email: string, name?: string | null): string {
  if (!name) return email;
  // eslint-disable-next-line no-control-regex
  const plain = /^[\x20-\x7e]*$/.test(name);
  return `${plain ? `"${name.replace(/["\\]/g, '\\$&')}"` : headerText(name)} <${email}>`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const two = (value: number) => String(value).padStart(2, '0');

function date(now: Date): string {
  return `${DAYS[now.getUTCDay()]}, ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} ${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())} +0000`;
}

/** A scheduling message as the message that carries it. */
export function schedulingMail(
  message: SchedulingMessage,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): Uint8Array {
  const domain = message.from.email.split('@')[1] ?? 'localhost';
  const outer = `=_mixed_${id}`;
  const inner = `=_alternative_${id}`;
  const method = message.method;
  const lines = [
    `From: ${mailbox(message.from.email, message.from.name)}`,
    `To: ${message.to.join(', ')}`,
    `Subject: ${headerText(message.subject)}`,
    `Date: ${date(now)}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    `--${inner}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(message.text.replace(/\r?\n/g, '\r\n')),
    `--${inner}`,
    `Content-Type: text/calendar; charset=utf-8; method=${method}`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(message.calendar),
    `--${inner}--`,
    `--${outer}`,
    `Content-Type: application/ics; name="invite.ics"`,
    'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(message.calendar),
    `--${outer}--`,
    '',
  ];
  return encoder.encode(lines.join('\r\n'));
}
