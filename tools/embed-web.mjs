#!/usr/bin/env node
// Puts a built web application into a module that the function serving it is
// bundled with, so that the function serves the pages itself and stays one file.
//
//   node tools/embed-web.mjs <built site> <module to write>
//
// The module is written next to a `web.ts` that says what `WebAssets` is.
//
// Text files are stored compressed; they are sent that way to browsers that
// take it, which all of them do.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node tools/embed-web.mjs <built site> <module>');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const COMPRESSED = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const assets = {};
for (const file of filesUnder(source).sort()) {
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) {
    console.error(`Not embedding ${file}: unknown kind of file`);
    process.exit(1);
  }
  const data = readFileSync(file);
  const gzip = COMPRESSED.test(type);
  assets[relative(source, file).split(sep).join('/')] = {
    type,
    gzip,
    // Level 9 and no timestamp: the same site always gives the same module.
    body: (gzip ? gzipSync(data, { level: 9 }) : data).toString('base64'),
  };
}
if (!assets['index.html']) {
  console.error(`${source} has no index.html. Build the application first.`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `// Written by tools/embed-web.mjs from ${source}. Not committed.\n` +
    "import type { WebAssets } from './web.js';\n\n" +
    `export const assets: WebAssets = ${JSON.stringify(assets, null, 2)};\n`,
);
console.log(`Embedded ${Object.keys(assets).length} files in ${target}`);
