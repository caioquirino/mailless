import type { Email } from '@mailless/jmap-core';
import { pictureChoices } from './senders';

const from = (email: string, keywords: Record<string, true> = {}) =>
  ({ from: [{ name: null, email }], keywords }) as unknown as Email;

describe('pictureChoices', () => {
  it('offers the sender, and the domain where it is one organisation’s', () => {
    expect(pictureChoices(from('News@Shop.Example'))).toEqual([
      'news@shop.example',
      '@shop.example',
    ]);
    // Where anyone can have an address, one sender says nothing of the others.
    expect(pictureChoices(from('someone@gmail.com'))).toEqual([
      'someone@gmail.com',
    ]);
  });

  it('offers nobody for a message nothing vouches for', () => {
    expect(
      pictureChoices(
        from('news@shop.example', { 'mailless-unverified': true }),
      ),
    ).toEqual([]);
    expect(
      pictureChoices(from('news@shop.example', { $phishing: true })),
    ).toEqual([]);
    expect(pictureChoices({ from: null, keywords: {} } as Email)).toEqual([]);
  });
});
