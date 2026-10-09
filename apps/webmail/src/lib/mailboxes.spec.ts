import { ownFolder } from './mailboxes';

describe('ownFolder', () => {
  it('is a folder the person made, or one with a role this page has no place for', () => {
    expect(ownFolder({ role: null })).toBe(true);
    // Another program's, to keep what it calls important: a folder like any other.
    expect(ownFolder({ role: 'important' })).toBe(true);
    for (const role of [
      'inbox',
      'drafts',
      'sent',
      'archive',
      'junk',
      'trash',
    ]) {
      expect(ownFolder({ role })).toBe(false);
    }
  });
});
