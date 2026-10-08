import { defineConfig } from '@hey-api/openapi-ts';

// The client is made from the API's OpenAPI document: `pnpm nx run admin-client:generate`.
// What it writes is not committed; every build makes it again.
export default defineConfig({
  input: '../admin-api/openapi.json',
  output: 'src/generated',
});
