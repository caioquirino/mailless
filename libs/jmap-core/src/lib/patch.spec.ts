import { applyPatch, PatchError, patchedProperties } from './patch.js';

describe('applyPatch', () => {
  const email = {
    id: 'e1',
    keywords: { $seen: true },
    mailboxIds: { inbox: true },
    subject: 'hello',
  };

  it('replaces top-level properties', () => {
    expect(
      applyPatch(email, { keywords: { $flagged: true } }).keywords,
    ).toEqual({ $flagged: true });
  });

  it('adds and removes nested keys', () => {
    const patched = applyPatch(email, {
      'keywords/$flagged': true,
      'keywords/$seen': null,
      'mailboxIds/archive': true,
    });
    expect(patched.keywords).toEqual({ $flagged: true });
    expect(patched.mailboxIds).toEqual({ inbox: true, archive: true });
  });

  it('sets a top-level property to null rather than deleting it', () => {
    expect(applyPatch(email, { subject: null })).toHaveProperty(
      'subject',
      null,
    );
  });

  it('does not mutate the input', () => {
    applyPatch(email, { 'keywords/$flagged': true });
    expect(email.keywords).toEqual({ $seen: true });
  });

  it('rejects a path whose parent does not exist', () => {
    expect(() => applyPatch(email, { 'missing/key': true })).toThrow(
      PatchError,
    );
    expect(() => applyPatch(email, { 'subject/key': true })).toThrow(
      PatchError,
    );
  });

  it('rejects overlapping patches', () => {
    expect(() =>
      applyPatch(email, { keywords: {}, 'keywords/$seen': true }),
    ).toThrow(PatchError);
  });

  it('rejects prototype-polluting paths', () => {
    expect(() => applyPatch(email, { '__proto__/polluted': true })).toThrow(
      PatchError,
    );
    expect(() => applyPatch(email, { 'constructor/polluted': true })).toThrow(
      PatchError,
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('unescapes path tokens', () => {
    const patched = applyPatch(
      { keywords: {} as Record<string, boolean> },
      { 'keywords/a~1b': true },
    );
    expect(patched.keywords).toEqual({ 'a/b': true });
  });
});

describe('patchedProperties', () => {
  it('lists the distinct top-level properties', () => {
    expect(
      patchedProperties({
        'keywords/$seen': true,
        'keywords/$flagged': true,
        mailboxIds: {},
      }),
    ).toEqual(['keywords', 'mailboxIds']);
  });
});
