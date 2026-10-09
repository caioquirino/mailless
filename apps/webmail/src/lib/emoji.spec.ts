import { EMOJI, findEmoji } from './emoji';

describe('emoji', () => {
  const all = EMOJI.flatMap((group) => group.emoji);

  it('are each one character every mail program knows, with a name', () => {
    expect(all.length).toBeGreaterThan(100);
    for (const emoji of all) {
      expect(emoji.name).not.toBe('');
      // One symbol, at most followed by the mark that asks for its coloured form.
      const points = [...emoji.char].filter((point) => point !== '\ufe0f');
      expect(points, emoji.name).toHaveLength(1);
    }
    expect(new Set(all.map((emoji) => emoji.char)).size).toBe(all.length);
  });

  it('are found by what they are called', () => {
    expect(findEmoji('thumbs').map((emoji) => emoji.char)).toEqual([
      '👍',
      '👎',
    ]);
    expect(findEmoji('heart red')[0]?.char).toBe('❤️');
    expect(findEmoji('no such thing')).toEqual([]);
  });
});
