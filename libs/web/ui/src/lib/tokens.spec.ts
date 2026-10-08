import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
const tokens = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8')) as {
  color: {
    themes: Array<{ id: string }>;
    tokens: Array<{
      name: string;
      value: Record<string, string>;
      usage: string;
    }>;
  };
};

/** How bright a colour is to the eye, from 0 to 1 (WCAG 2). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

describe('the tokens', () => {
  it('are written to the stylesheet as they are defined', () => {
    // Fails when tokens.json was changed and the stylesheet was not made again.
    execFileSync('node', [
      join(root, '../../../tools/build-tokens.mjs'),
      '--check',
    ]);
  });

  it('each have a value in every theme, and say what they are for', () => {
    for (const token of tokens.color.tokens) {
      for (const theme of tokens.color.themes) {
        expect(token.value[theme.id], `${token.name} in ${theme.id}`).toMatch(
          /^#[0-9A-F]{6}$/,
        );
      }
      expect(token.usage.length, token.name).toBeGreaterThan(10);
    }
  });

  // Text on the ground it is meant for, as the usage notes say.
  const pairs: Array<[string, string]> = [
    ['text', 'page'],
    ['text', 'surface'],
    ['text', 'raised'],
    ['text', 'hover'],
    ['muted', 'page'],
    ['muted', 'surface'],
    ['muted', 'raised'],
    ['accent', 'surface'],
    ['accent', 'page'],
    ['accent-text', 'accent'],
    ['accent-soft-text', 'accent-soft'],
    ['danger-text', 'danger'],
    ['danger', 'danger-soft'],
    ['danger', 'surface'],
    ['success', 'success-soft'],
    ['warning', 'warning-soft'],
  ];
  const value = (name: string, theme: string) =>
    tokens.color.tokens.find((token) => token.name === name)?.value[
      theme
    ] as string;

  it.each(tokens.color.themes.map((theme) => theme.id))(
    'can be read in the %s theme',
    (theme) => {
      for (const [text, ground] of pairs) {
        expect(
          contrast(value(text, theme), value(ground, theme)),
          `${text} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      // What can be pressed has an edge that can be seen.
      expect(
        contrast(value('focus', theme), value('surface', theme)),
      ).toBeGreaterThanOrEqual(3);
    },
  );

  it('give every avatar a colour that white can be read on', () => {
    const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
    const tones = [
      ...css.matchAll(/\.avatar-tone-\d \{\s*background: (#[0-9a-f]{6});/g),
    ].map((match) => match[1] as string);
    expect(tones).toHaveLength(6);
    for (const tone of tones) {
      expect(contrast('#ffffff', tone), tone).toBeGreaterThanOrEqual(4.5);
    }
  });
});
