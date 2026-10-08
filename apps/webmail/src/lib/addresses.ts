import type { EmailAddress } from '@mailless/jmap-core';

/** One address as people write it: `Ann Lee <ann@example.com>`, or the address alone. */
export function formatAddress(address: EmailAddress): string {
  if (!address.name) return address.email;
  const name = /[",<>@;:\\]/.test(address.name)
    ? `"${address.name.replace(/(["\\])/g, '\\$1')}"`
    : address.name;
  return `${name} <${address.email}>`;
}

export function formatAddresses(
  addresses: readonly EmailAddress[] | null | undefined,
): string {
  return (addresses ?? []).map(formatAddress).join(', ');
}

/** What to call someone in a list: their name, or failing that their address. */
export function nameOf(address: EmailAddress): string {
  return address.name?.trim() || address.email;
}

/** Splits at commas and semicolons that are not inside quotes or angle brackets. */
function split(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (char === '\\' && quoted) {
      current += char + (text[++index] ?? '');
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (char === '<' && !quoted) angled = true;
    else if (char === '>' && !quoted) angled = false;
    if ((char === ',' || char === ';' || char === '\n') && !quoted && !angled) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

const ADDRESS =
  /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;.]+$|^[^\s@<>"',;]+@[^\s@<>"',;.]+$/;

export type Parsed =
  | { addresses: EmailAddress[]; invalid?: undefined }
  /** The first piece that is not an address, as it was written. */
  | { invalid: string; addresses?: undefined };

/** Reads a line of addresses as people type them. */
export function parseAddresses(text: string): Parsed {
  const addresses: EmailAddress[] = [];
  for (const part of split(text)) {
    const named = /^(.*)<([^<>]*)>$/.exec(part);
    const email = (named ? named[2] : part)?.trim() ?? '';
    if (!ADDRESS.test(email)) return { invalid: part };
    const name = named
      ? (named[1] ?? '')
          .trim()
          .replace(/^"(.*)"$/, '$1')
          .replace(/\\(.)/g, '$1')
      : '';
    addresses.push({ name: name === '' ? null : name, email });
  }
  return { addresses };
}
