#!/usr/bin/env node
// Writes the design system's tokens as CSS, from the one place they are
// defined: libs/web/ui/tokens.json. Run it after changing a token:
//
//   node tools/build-tokens.mjs            writes the stylesheet
//   node tools/build-tokens.mjs --check    fails if the stylesheet is out of date
//
// The light palette is the default. The dark one applies when the system asks
// for it, unless the person chose light; and when the person chose dark,
// whatever the system says.
import { readFileSync, writeFileSync } from 'node:fs';

const source = new URL('../libs/web/ui/tokens.json', import.meta.url);
const target = new URL('../libs/web/ui/src/styles/tokens.css', import.meta.url);

export function tokensCss(tokens) {
  const [first, ...others] = tokens.color.themes.map((theme) => theme.id);
  const colors = (theme) =>
    tokens.color.tokens.map((token) => {
      const value =
        typeof token.value === 'string'
          ? token.value
          : (token.value[theme] ?? token.value[first]);
      return `  --${token.name}: ${value.toLowerCase()};`;
    });
  const plain = ['spacing', 'radius', 'shadow'].flatMap((family) =>
    (tokens[family]?.tokens ?? []).map(
      (token) => `  --${token.name}: ${token.value};`,
    ),
  );
  const families = Object.entries(tokens.type.families).map(
    ([name, stack]) => `  --font-${name}: ${stack};`,
  );
  const indent = (lines) => lines.map((line) => `  ${line}`);

  const blocks = [
    '/* Written by tools/build-tokens.mjs from tokens.json. Change that file, not this one. */',
    [
      ':root {',
      `  color-scheme: ${first};`,
      '',
      ...colors(first),
      '',
      ...plain,
      '',
      ...families,
      '}',
    ].join('\n'),
  ];
  for (const theme of others) {
    blocks.push(
      [
        `@media (prefers-color-scheme: ${theme}) {`,
        `  :root:not([data-theme='${first}']) {`,
        `    color-scheme: ${theme};`,
        '',
        ...indent(colors(theme)),
        '  }',
        '}',
      ].join('\n'),
      [
        `:root[data-theme='${theme}'] {`,
        `  color-scheme: ${theme};`,
        '',
        ...colors(theme),
        '}',
      ].join('\n'),
    );
  }
  return `${blocks.join('\n\n')}\n`;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const css = tokensCss(JSON.parse(readFileSync(source, 'utf8')));
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== css) {
      console.error(
        'libs/web/ui/src/styles/tokens.css is out of date. Run: node tools/build-tokens.mjs',
      );
      process.exit(1);
    }
  } else {
    writeFileSync(target, css);
    console.log('Wrote libs/web/ui/src/styles/tokens.css');
  }
}
