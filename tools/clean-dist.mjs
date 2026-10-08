// Removes the build output of every library, so that a release is built from
// nothing. A compiler only adds to its output folder: a file whose source was
// moved or deleted stays there, and would be published with the rest.
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const libs = join(dirname(dirname(fileURLToPath(import.meta.url))), 'libs');
for (const group of readdirSync(libs, { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const lib of readdirSync(join(libs, group.name), {
    withFileTypes: true,
  })) {
    if (!lib.isDirectory()) continue;
    rmSync(join(libs, group.name, lib.name, 'dist'), {
      recursive: true,
      force: true,
    });
  }
}
