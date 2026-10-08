import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import {
  createAdminWeb,
  securityHeaders,
  webConfigurationFromEnvironment,
  type WebAssets,
} from './web.js';

const gz = (text: string) => gzipSync(Buffer.from(text)).toString('base64');
const assets: WebAssets = {
  'index.html': {
    type: 'text/html; charset=utf-8',
    gzip: true,
    body: gz('<!doctype html><title>Admin</title>'),
  },
  'assets/app-abc123.js': {
    type: 'text/javascript; charset=utf-8',
    gzip: true,
    body: gz('console.log("app")'),
  },
  'favicon.ico': {
    type: 'image/x-icon',
    gzip: false,
    body: Buffer.from([0, 0, 1, 0]).toString('base64'),
  },
};
const configuration = {
  apiBaseUrl: '/admin/api',
  clientId: 'admin-client',
  authorizeUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  logoutUrl: 'https://auth.example.com/logout',
  scopes: ['openid'],
  passkeyEnrolmentUrl: null,
};
// Mounted under /admin, as the function mounts it.
const web = new Hono().route(
  '/admin',
  createAdminWeb({ assets, configuration, mountedAt: '/admin' }),
);
const get = (path: string, headers: Record<string, string> = {}) =>
  web.request(`/admin${path === '/' ? '' : path}`, { headers });

describe('admin web', () => {
  it('serves the page for the interface’s own addresses', async () => {
    for (const path of [
      '/',
      '/accounts',
      '/accounts/ann',
      '/callback?code=x',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      );
      // The page itself is always asked for again, so a new version is seen at once.
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(await response.text()).toContain('<title>Admin</title>');
    }
  });

  it('serves built files to be kept, and compressed to browsers that take it', async () => {
    const plain = await get('/assets/app-abc123.js');
    expect(plain.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(plain.headers.get('vary')).toBe('accept-encoding');
    expect(await plain.text()).toBe('console.log("app")');

    const packed = await get('/assets/app-abc123.js', {
      'accept-encoding': 'gzip, br',
    });
    expect(packed.headers.get('content-encoding')).toBe('gzip');
    expect(Buffer.from(await packed.arrayBuffer()).toString('base64')).toBe(
      assets['assets/app-abc123.js']?.body,
    );

    const icon = await get('/favicon.ico');
    expect(icon.headers.get('content-type')).toBe('image/x-icon');
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(
      new Uint8Array([0, 0, 1, 0]),
    );
  });

  it('answers a missing file as missing, not with the page', async () => {
    for (const path of ['/assets/old-123.js', '/robots.txt', '/app.css.map']) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await web.request('/admin', { method: 'POST' })).status).toBe(404);
    // With or without the closing slash, it is the same page.
    expect((await web.request('/admin/')).status).toBe(200);
  });

  it('gives the pages their configuration, never to be kept', async () => {
    const response = await get('/config.json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(configuration);
  });

  it('sends every answer with headers that keep other people’s scripts out', async () => {
    for (const path of [
      '/',
      '/config.json',
      '/assets/app-abc123.js',
      '/x.png',
    ]) {
      const response = await get(path);
      const policy = response.headers.get('content-security-policy') ?? '';
      expect(policy, path).toContain("script-src 'self'");
      expect(policy).toContain("style-src 'self'");
      expect(policy).toContain("connect-src 'self' https://auth.example.com");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toContain('unsafe');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('names each provider origin once in the policy, and none it was not given', () => {
    const policy = securityHeaders({
      ...configuration,
      authorizeUrl: 'https://login.example.net/authorize',
    })['content-security-policy'];
    expect(policy).toContain(
      "connect-src 'self' https://auth.example.com https://login.example.net;",
    );
    expect(
      securityHeaders({ ...configuration, tokenUrl: '', authorizeUrl: 'x' })[
        'content-security-policy'
      ],
    ).toContain("connect-src 'self';");
  });
});

describe('webConfigurationFromEnvironment', () => {
  const env = {
    ADMIN_CLIENT_ID: 'admin-client',
    AUTH_AUTHORIZE_URL: 'https://auth.example.com/oauth2/authorize',
    AUTH_TOKEN_URL: 'https://auth.example.com/oauth2/token',
    AUTH_LOGOUT_URL: 'https://auth.example.com/logout',
  };

  it('reads what a deployment sets', () => {
    expect(
      webConfigurationFromEnvironment({
        ...env,
        AUTH_SCOPES: '["openid","aws.cognito.signin.user.admin"]',
        PASSKEY_ENROLMENT_URL: 'https://auth.example.com/passkeys/add',
      }),
    ).toEqual({
      apiBaseUrl: '/admin/api',
      clientId: 'admin-client',
      authorizeUrl: env.AUTH_AUTHORIZE_URL,
      tokenUrl: env.AUTH_TOKEN_URL,
      logoutUrl: env.AUTH_LOGOUT_URL,
      scopes: ['openid', 'aws.cognito.signin.user.admin'],
      passkeyEnrolmentUrl: 'https://auth.example.com/passkeys/add',
    });
    expect(webConfigurationFromEnvironment(env)).toMatchObject({
      scopes: ['openid'],
      passkeyEnrolmentUrl: null,
    });
  });

  it('says what is missing or wrong', () => {
    expect(() =>
      webConfigurationFromEnvironment({ ...env, ADMIN_CLIENT_ID: '' }),
    ).toThrow(/ADMIN_CLIENT_ID/);
    expect(() =>
      webConfigurationFromEnvironment({ ...env, AUTH_SCOPES: '"openid"' }),
    ).toThrow(/AUTH_SCOPES/);
  });
});
