/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/webmail',
  // The webmail is served under /mail/, next to the JMAP API.
  base: '/mail/',
  server: {
    port: 5174,
    host: 'localhost',
    // On your own machine the pages come from here and everything else from a
    // real deployment: `MAIL_BACKEND=https://mail.example.com pnpm nx dev webmail`.
    // The browser sees one origin, so the API needs no CORS.
    proxy: process.env['MAIL_BACKEND']
      ? Object.fromEntries(
          ['/mail/config.json', '/.well-known/jmap', '/jmap'].map((path) => [
            path,
            { target: process.env['MAIL_BACKEND'], changeOrigin: true },
          ]),
        )
      : undefined,
  },
  preview: {
    port: 4301,
    host: 'localhost',
  },
  plugins: [react()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  test: {
    name: 'webmail',
    watch: false,
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Each test runs the whole application; on a small shared machine that takes a while.
    testTimeout: 30_000,
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
