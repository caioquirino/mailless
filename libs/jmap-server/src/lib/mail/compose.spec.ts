import PostalMime from 'postal-mime';
import {
  ComposeError,
  composeMessage,
  encodeText,
  formatAddresses,
  formatDate,
  formatMessageIds,
  removeHeader,
} from './compose.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (value: string, type = 'text/plain') => ({
  type,
  content: encoder.encode(value),
});
const parse = (raw: Uint8Array) =>
  PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
const lines = (raw: Uint8Array) => decoder.decode(raw).split('\r\n');

describe('composeMessage', () => {
  it('writes a plain ASCII message without encoding it', async () => {
    const raw = composeMessage(
      [
        { name: 'From', value: 'a@example.com' },
        { name: 'Subject', value: 'Hello' },
      ],
      text('Line one\r\nLine two'),
    );
    const message = decoder.decode(raw);
    expect(message).toContain('Content-Transfer-Encoding: 7bit');
    expect(message).toContain('MIME-Version: 1.0');
    // Nothing follows the body: a line break there would be part of the text.
    expect(message.endsWith('Line one\r\nLine two')).toBe(true);

    const parsed = await parse(raw);
    expect(parsed.subject).toBe('Hello');
    expect(parsed.text?.trim()).toBe('Line one\nLine two');
  });

  it('round-trips non-ASCII text, long lines and awkward whitespace', async () => {
    const body = [
      'Olá, João — ça va? 日本語',
      'x'.repeat(300),
      'trailing space ',
      'equals = sign',
      '',
      'last',
    ].join('\n');
    const raw = composeMessage(
      [{ name: 'From', value: 'a@example.com' }],
      text(body),
    );
    expect(decoder.decode(raw)).toContain('quoted-printable');
    for (const line of lines(raw)) expect(line.length).toBeLessThanOrEqual(76);
    expect((await parse(raw)).text).toBe(`${body}\n`);
  });

  it('builds alternative and mixed multiparts with attachments', async () => {
    const pdf = Uint8Array.from({ length: 700 }, (_, index) => index % 256);
    const raw = composeMessage([{ name: 'From', value: 'a@example.com' }], {
      type: 'multipart/mixed',
      subParts: [
        {
          type: 'multipart/alternative',
          subParts: [text('plain é'), text('<p>rich é</p>', 'text/html')],
        },
        {
          type: 'application/pdf',
          name: 'relatório final.pdf',
          disposition: 'attachment',
          content: pdf,
        },
        {
          type: 'image/png',
          cid: 'logo@x',
          disposition: 'inline',
          content: pdf,
        },
      ],
    });
    for (const line of lines(raw)) expect(line.length).toBeLessThanOrEqual(76);

    const parsed = await parse(raw);
    expect(parsed.text?.trim()).toBe('plain é');
    expect(parsed.html?.trim()).toBe('<p>rich é</p>');
    expect(parsed.attachments).toHaveLength(2);
    const [attachment, inline] = parsed.attachments;
    expect(attachment).toMatchObject({
      filename: 'relatório final.pdf',
      mimeType: 'application/pdf',
      disposition: 'attachment',
    });
    expect(new Uint8Array(attachment?.content as ArrayBuffer)).toEqual(pdf);
    expect(inline).toMatchObject({
      disposition: 'inline',
      contentId: '<logo@x>',
    });
  });

  it('writes an empty body for a part without content', async () => {
    const raw = composeMessage([{ name: 'From', value: 'a@example.com' }], {
      type: 'text/plain',
    });
    expect(((await parse(raw)).text ?? '').trim()).toBe('');
  });

  it('encodes and folds headers', async () => {
    const subject = `Relatório ${'muito '.repeat(20)}longo — ✓`;
    const raw = composeMessage(
      [
        {
          name: 'From',
          value: formatAddresses([
            { name: 'João "JJ" Araújo', email: 'joao@example.com' },
          ]),
        },
        {
          name: 'To',
          value: formatAddresses([
            { name: 'Smith, Bob', email: 'bob@example.com' },
            { name: null, email: 'carol@example.com' },
            { name: 'Plain Name', email: 'dave@example.com' },
          ]),
        },
        { name: 'Subject', value: encodeText(subject) },
        { name: 'References', value: formatMessageIds(['a@x', 'b@y']) },
      ],
      text('hi'),
    );
    for (const line of lines(raw)) {
      expect(line.length).toBeLessThanOrEqual(78);
      expect(
        [...line].every((character) => character.charCodeAt(0) < 128),
      ).toBe(true);
    }

    const parsed = await parse(raw);
    expect(parsed.subject).toBe(subject);
    expect(parsed.from).toEqual({
      name: 'João "JJ" Araújo',
      address: 'joao@example.com',
    });
    expect(parsed.to).toEqual([
      { name: 'Smith, Bob', address: 'bob@example.com' },
      { name: '', address: 'carol@example.com' },
      { name: 'Plain Name', address: 'dave@example.com' },
    ]);
    expect(parsed.references).toBe('<a@x> <b@y>');
  });

  it('refuses anything that could inject headers', () => {
    const body = text('x');
    expect(() =>
      composeMessage(
        [{ name: 'Subject', value: 'a\r\nBcc: evil@example.com' }],
        body,
      ),
    ).toThrow(ComposeError);
    expect(() =>
      composeMessage([{ name: 'Bad Name', value: 'x' }], body),
    ).toThrow(ComposeError);
    expect(() => composeMessage([{ name: 'X:Y', value: 'x' }], body)).toThrow(
      ComposeError,
    );
    expect(() => encodeText('line\nbreak')).toThrow(ComposeError);
    expect(() =>
      formatAddresses([{ name: 'a\r\nb', email: 'a@example.com' }]),
    ).toThrow(ComposeError);
    for (const email of [
      'not-an-address',
      'a@b@c',
      'a b@example.com',
      'a@example.com>',
      '',
    ]) {
      expect(() => formatAddresses([{ name: null, email }]), email).toThrow(
        ComposeError,
      );
    }
    expect(() => formatMessageIds(['a b'])).toThrow(ComposeError);
    expect(() => formatMessageIds(['<a@b>'])).toThrow(ComposeError);
  });

  it('refuses malformed part trees', () => {
    const headers = [{ name: 'From', value: 'a@example.com' }];
    expect(() => composeMessage(headers, { type: 'multipart/mixed' })).toThrow(
      ComposeError,
    );
    expect(() =>
      composeMessage(headers, { type: 'text/plain', subParts: [text('x')] }),
    ).toThrow(ComposeError);
    expect(() =>
      composeMessage(headers, { type: 'text/plain\r\nX: 1' }),
    ).toThrow(ComposeError);
    expect(() =>
      composeMessage(headers, {
        ...text('x'),
        disposition: 'attachment\r\nX: 1',
      }),
    ).toThrow(ComposeError);
  });

  it('formats dates in RFC 5322 form', () => {
    expect(formatDate(new Date('2026-10-07T09:05:03Z'))).toBe(
      'Wed, 07 Oct 2026 09:05:03 +0000',
    );
  });
});

describe('removeHeader', () => {
  const raw = encoder.encode(
    [
      'From: a@example.com',
      'Bcc: secret@example.com,',
      ' other@example.com',
      'To: b@example.com',
      'bcc: third@example.com',
      'Subject: Bcc: is mentioned here',
      '',
      'Bcc: this line is body text',
      '',
    ].join('\r\n'),
  );

  it('removes every occurrence with its continuation lines, and only in the header', () => {
    expect(decoder.decode(removeHeader(raw, 'Bcc'))).toBe(
      [
        'From: a@example.com',
        'To: b@example.com',
        'Subject: Bcc: is mentioned here',
        '',
        'Bcc: this line is body text',
        '',
      ].join('\r\n'),
    );
  });

  it('leaves the bytes of everything else untouched', () => {
    const binary = Uint8Array.from([
      ...encoder.encode('Bcc: x@example.com\r\nTo: y@example.com\r\n\r\n'),
      0,
      200,
      255,
      10,
    ]);
    expect([...removeHeader(binary, 'bcc')]).toEqual([
      ...encoder.encode('To: y@example.com\r\n\r\n'),
      0,
      200,
      255,
      10,
    ]);
    expect(removeHeader(raw, 'X-Absent')).toEqual(raw);
  });
});
