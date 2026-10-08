import { base64Url, challengeFor, randomToken, sameText } from './pkce.js';

describe('PKCE helpers', () => {
  it('derives the challenge of a verifier as RFC 7636 says', async () => {
    // The example of RFC 7636, appendix B.
    expect(
      await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes tokens that are long, URL-safe and never the same twice', () => {
    const tokens = new Set(Array.from({ length: 50 }, randomToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('encodes bytes without the characters a URL would change', () => {
    expect(base64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64Url(new Uint8Array([1]))).toBe('AQ');
  });

  it('compares texts in full', () => {
    expect(sameText('abc', 'abc')).toBe(true);
    expect(sameText('abc', 'abd')).toBe(false);
    expect(sameText('abc', 'abcd')).toBe(false);
    expect(sameText('', '')).toBe(true);
  });
});
