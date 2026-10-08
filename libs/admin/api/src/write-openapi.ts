// Writes the OpenAPI document of the API next to the package:
// `pnpm nx run admin-api:openapi`. A test fails when the file is out of date.
import { writeFileSync } from 'node:fs';
import { adminApiDocument } from './lib/app.js';

const target = new URL('../openapi.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(adminApiDocument(), null, 2)}\n`);
console.log(`Wrote ${target.pathname}`);
