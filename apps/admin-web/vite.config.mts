/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/admin-web',
  // The interface is served under /admin/, next to the JMAP API.
  base: '/admin/',
  server: {
    port: 5173,
    host: 'localhost',
    // On your own machine the pages come from here and everything else from a
    // real deployment: `ADMIN_BACKEND=https://mail.example.com pnpm nx dev admin-web`.
    // The browser sees one origin, so the API needs no CORS.
    proxy: process.env['ADMIN_BACKEND']
      ? Object.fromEntries(
          ['/admin/api', '/admin/config.json'].map((path) => [
            path,
            { target: process.env['ADMIN_BACKEND'], changeOrigin: true },
          ]),
        )
      : undefined,
  },
  preview: {
    port: 4300,
    host: 'localhost',
  },
  plugins: [react()],
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [],
  // },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  test: {
    name: 'admin-web',
    watch: false,
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
