import {
  buildBodyLayout,
  InvalidMessageError,
  parseMailDate,
  parseMessage,
  partText,
  type ParsedPart,
} from './mime.js';

const encoder = new TextEncoder();
const parse = (lines: string[]) =>
  parseMessage(encoder.encode(lines.join('\r\n')));
const shape = (part: ParsedPart): unknown =>
  part.subParts ? { [part.type]: part.subParts.map(shape) } : part.type;
const text = (part: ParsedPart | undefined) =>
  partText(part as ParsedPart).value;

describe('parseMessage: structure', () => {
  it('keeps the tree of parts as it is in the message', async () => {
    const message = await parse([
      'From: a@example.com',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      'This preamble is not a part.',
      '--outer',
      'Content-Type: multipart/alternative; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain text',
      '--inner',
      'Content-Type: multipart/related; boundary="rel"',
      '',
      '--rel',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Rich <img src="cid:logo"></p>',
      '--rel',
      'Content-Type: image/png',
      'Content-ID: <logo>',
      'Content-Disposition: inline; filename=logo.png',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--rel--',
      '--inner--',
      '--outer',
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0x',
      'LjQ=',
      '--outer--',
      'This epilogue is not a part either.',
      '',
    ]);

    expect(shape(message.structure)).toEqual({
      'multipart/mixed': [
        {
          'multipart/alternative': [
            'text/plain',
            { 'multipart/related': ['text/html', 'image/png'] },
          ],
        },
        'application/pdf',
      ],
    });
    expect(message.parts.map((part) => part.partId)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(message.textBody).toEqual(['1']);
    expect(message.htmlBody).toEqual(['2']);
    // The picture belongs to the HTML; only the PDF is offered for download.
    expect(message.attachments).toEqual(['3', '4']);
    expect(message.metadata.hasAttachment).toBe(true);
    expect(message.metadata.preview).toBe('Plain text');

    const [plain, , image, pdf] = message.parts;
    expect(text(plain)).toBe('Plain text');
    expect(image).toMatchObject({
      type: 'image/png',
      cid: 'logo',
      disposition: 'inline',
      name: 'logo.png',
      charset: null,
    });
    expect([...(image as ParsedPart).data]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(new TextDecoder().decode(pdf?.data)).toBe('%PDF-1.4');
    expect(pdf?.headers.map((header) => header.name)).toEqual([
      'Content-Type',
      'Content-Disposition',
      'Content-Transfer-Encoding',
    ]);

    const layout = buildBodyLayout(message, 'blob');
    expect(layout.bodyStructure.headers).toEqual([]);
    expect(layout.bodyStructure.subParts?.[1]).toMatchObject({
      partId: '4',
      blobId: 'blob-4',
      size: 8,
      name: 'report.pdf',
      headers: pdf?.headers,
    });
  });

  it('follows the RFC in what counts as body and what as attachment', async () => {
    const mixed = await parse([
      'From: a@example.com',
      'Content-Type: multipart/mixed; boundary=b',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'Before the picture',
      '--b',
      'Content-Type: image/jpeg',
      '',
      'x',
      '--b',
      'Content-Type: text/plain',
      '',
      'After the picture',
      '--b',
      'Content-Type: text/plain; name=notes.txt',
      '',
      'A named text file',
      '--b--',
    ]);
    // Text and pictures in sequence are all body; a named text part is a file.
    expect(mixed.textBody).toEqual(['1', '2', '3']);
    expect(mixed.htmlBody).toEqual(['1', '2', '3']);
    expect(mixed.attachments).toEqual(['4']);
    expect(mixed.metadata.hasAttachment).toBe(true);

    const htmlOnly = await parse([
      'From: a@example.com',
      'Content-Type: multipart/alternative; boundary=b',
      '',
      '--b',
      'Content-Type: text/html',
      '',
      '<p>Only &eacute;</p>',
      '--b--',
    ]);
    // With no plain alternative, the HTML is the text body too.
    expect(htmlOnly.textBody).toEqual(['1']);
    expect(htmlOnly.htmlBody).toEqual(['1']);
    expect(htmlOnly.metadata.preview).toBe('Only é');
    expect(htmlOnly.metadata.hasAttachment).toBe(false);
  });

  it('reads a message that is a single part', async () => {
    const message = await parse([
      'Subject: =?UTF-8?B?T2zDoQ==?= there',
      'From: "Doe, Jane" <jane@example.com>, bob@example.org',
      'To: Team: a@example.com, b@example.com;',
      'Message-ID: <m1@example.com>',
      'References: <r1@example.com>',
      '  <r2@example.com>',
      '',
      'First line',
      'Second line',
    ]);
    expect(shape(message.structure)).toBe('text/plain');
    expect(message.structure).toMatchObject({
      partId: '1',
      charset: 'us-ascii',
      disposition: null,
      name: null,
    });
    expect(text(message.structure)).toBe('First line\nSecond line');
    expect(message.textBody).toEqual(['1']);
    expect(message.htmlBody).toEqual(['1']);
    expect(message.attachments).toEqual([]);
    expect(message.metadata).toMatchObject({
      subject: 'Olá there',
      from: [
        { name: 'Doe, Jane', email: 'jane@example.com' },
        { name: null, email: 'bob@example.org' },
      ],
      to: [
        { name: null, email: 'a@example.com' },
        { name: null, email: 'b@example.com' },
      ],
      cc: null,
      messageId: ['m1@example.com'],
      references: ['r1@example.com', 'r2@example.com'],
      sentAt: null,
      hasAttachment: false,
    });
    // Folded header values keep their line breaks in the raw form.
    expect(message.metadata.headers[4]).toEqual({
      name: 'References',
      value: ' <r1@example.com>\r\n  <r2@example.com>',
    });
  });

  it('decodes transfer encodings and character sets', async () => {
    const raw = encoder.encode(
      [
        'From: a@example.com',
        'Content-Type: multipart/mixed; boundary=b',
        '',
        '--b',
        'Content-Type: text/plain; charset=iso-8859-1',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Caf=E9 au lait, soft =',
        'break, and a stray = sign=3D',
        '--b',
        'Content-Type: text/plain; charset="windows-1252"',
        'Content-Transfer-Encoding: BASE64',
        '',
        'gCBldXJv',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'broken @ bytes',
        '--b',
        'Content-Type: text/plain; charset=x-not-a-charset',
        '',
        'still readable',
        '--b--',
      ].join('\r\n'),
    );
    // One byte that is not valid UTF-8, where the message claims UTF-8.
    raw[raw.lastIndexOf(0x40)] = 0xff;
    const message = await parseMessage(raw);
    expect(message.parts.map((part) => partText(part))).toEqual([
      {
        value: 'Café au lait, soft break, and a stray = sign=',
        isEncodingProblem: false,
      },
      { value: '€ euro', isEncodingProblem: false },
      { value: 'broken � bytes', isEncodingProblem: true },
      { value: 'still readable', isEncodingProblem: true },
    ]);
    expect(message.parts[0]?.charset).toBe('iso-8859-1');
    expect(message.parts[0]?.data).toHaveLength(45);
  });

  it('reads file names however they are encoded', async () => {
    const name = async (...headers: string[]) =>
      (
        await parse([
          'From: a@example.com',
          'Content-Type: multipart/mixed; boundary=b',
          '',
          '--b',
          ...headers,
          '',
          'x',
          '--b--',
        ])
      ).parts[0]?.name;

    expect(
      await name(
        'Content-Type: application/pdf; name="from type.pdf"',
        'Content-Disposition: attachment; filename="from disposition.pdf"',
      ),
    ).toBe('from disposition.pdf');
    expect(
      await name('Content-Type: application/pdf; name="only type.pdf"'),
    ).toBe('only type.pdf');
    expect(
      await name(
        "Content-Disposition: attachment; filename*=UTF-8''Relat%C3%B3rio%20final.pdf",
      ),
    ).toBe('Relatório final.pdf');
    expect(
      await name(
        'Content-Disposition: attachment;',
        " filename*0*=UTF-8''Um%20nome%20muito%20;",
        ' filename*1*=comprido%20com%20a%C3%A7%C3%A3o;',
        ' filename*2=".pdf"',
      ),
    ).toBe('Um nome muito comprido com ação.pdf');
    expect(
      await name(
        'Content-Disposition: attachment; filename="=?UTF-8?B?w6FydmlvLnR4dA==?="',
      ),
    ).toBe('árvio.txt');
    expect(
      await name('Content-Disposition: attachment; filename="a \\"b\\".txt"'),
    ).toBe('a "b".txt');
    expect(await name('Content-Type: text/plain')).toBeNull();
  });

  it('copes with messages that are not quite right', async () => {
    // A multipart whose boundary never appears is shown as text.
    const lost = await parse([
      'From: a@example.com',
      'Content-Type: multipart/mixed; boundary=missing',
      '',
      'Just text after all',
    ]);
    expect(shape(lost.structure)).toBe('text/plain');
    expect(text(lost.structure)).toBe('Just text after all');

    // A multipart that is never closed still yields its parts.
    const open = await parse([
      'From: a@example.com',
      'Content-Type: multipart/mixed; boundary=b',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'One',
      '--b',
      '',
      'Two, with no headers at all',
    ]);
    expect(open.parts.map(text)).toEqual([
      'One',
      'Two, with no headers at all',
    ]);

    // A line that only begins like a delimiter is content.
    const lookalike = await parse([
      'From: a@example.com',
      'Content-Type: multipart/mixed; boundary=b',
      '',
      '--b',
      '',
      '--bogus is not the boundary',
      '--b--',
    ]);
    expect(lookalike.parts.map(text)).toEqual(['--bogus is not the boundary']);

    // Bare line feeds instead of CRLF.
    const unix = await parseMessage(
      encoder.encode(
        'From: a@example.com\nContent-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nUnix lines\n--b--\n',
      ),
    );
    expect(unix.parts.map(text)).toEqual(['Unix lines']);

    // Inside a digest, a part without a type is a message.
    const digest = await parse([
      'From: a@example.com',
      'Content-Type: multipart/digest; boundary=b',
      '',
      '--b',
      '',
      'From: inner@example.com',
      '',
      'Inner',
      '--b--',
    ]);
    expect(shape(digest.structure)).toEqual({
      'multipart/digest': ['message/rfc822'],
    });
    expect(digest.attachments).toEqual(['1']);

    await expect(
      parseMessage(encoder.encode('\r\nno headers')),
    ).rejects.toThrow(InvalidMessageError);
    await expect(parseMessage(new Uint8Array())).rejects.toThrow(
      InvalidMessageError,
    );
  });

  it('does not follow nesting without end', async () => {
    const lines = ['From: a@example.com'];
    for (let depth = 0; depth < 200; depth++) {
      lines.push(
        `Content-Type: multipart/mixed; boundary=b${depth}`,
        '',
        `--b${depth}`,
      );
    }
    lines.push('Content-Type: text/plain', '', 'deep');
    const message = await parse(lines);
    let depth = 0;
    for (let part = message.structure; part.subParts; depth++) {
      part = part.subParts[0] as ParsedPart;
    }
    expect(depth).toBeLessThanOrEqual(32);
    expect(message.parts).toHaveLength(1);
  });
});

describe('parseMailDate', () => {
  it('keeps the offset the date was written with', () => {
    expect(parseMailDate(' Tue, 06 Oct 2026 14:00:00 +0200')).toBe(
      '2026-10-06T14:00:00+02:00',
    );
    expect(parseMailDate('Thu, 13 Feb 1969 23:32:00 -0330')).toBe(
      '1969-02-13T23:32:00-03:30',
    );
    expect(parseMailDate('6 Oct 2026 12:00 +0000')).toBe(
      '2026-10-06T12:00:00Z',
    );
    expect(parseMailDate('Tue, 6 Oct 2026 08:00:05 EDT')).toBe(
      '2026-10-06T08:00:05-04:00',
    );
    expect(parseMailDate('Tue, 06 Oct 2026 12:00:00 GMT')).toBe(
      '2026-10-06T12:00:00Z',
    );
    expect(parseMailDate('Tue, 06 Oct 2026 14:00:00 +0200 (CEST)')).toBe(
      '2026-10-06T14:00:00+02:00',
    );
    expect(parseMailDate('Tue, 06 Oct 2026\r\n 14:00:00 +0200')).toBe(
      '2026-10-06T14:00:00+02:00',
    );
    expect(parseMailDate('Mon, 1 Jan 99 00:00:00 +0000')).toBe(
      '1999-01-01T00:00:00Z',
    );
  });

  it('answers null for what is not a date', () => {
    for (const value of [
      '',
      'yesterday',
      '2026-10-06T12:00:00Z',
      '31 Feb 2026 12:00:00 +0000',
      '6 Oct 2026 25:00:00 +0000',
      '6 Foo 2026 12:00:00 +0000',
    ]) {
      expect(parseMailDate(value), value).toBeNull();
    }
  });
});
