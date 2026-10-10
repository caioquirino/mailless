import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import {
  createWebmail,
  webmailConfigurationFromEnvironment,
  webmailSecurityHeaders,
  type WebAssets,
} from './web.js';

const gz = (text: string) => gzipSync(Buffer.from(text)).toString('base64');
const assets: WebAssets = {
  'index.html': {
    type: 'text/html; charset=utf-8',
    gzip: true,
    body: gz('<!doctype html><title>Mail</title>'),
  },
  'assets/app-abc123.js': {
    type: 'text/javascript; charset=utf-8',
    gzip: true,
    body: gz('console.log("app")'),
  },
};
const configuration = {
  sessionUrl: '/.well-known/jmap',
  clientId: 'webmail-client',
  authorizeUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  logoutUrl: 'https://auth.example.com/logout',
  revokeUrl: 'https://auth.example.com/oauth2/revoke',
  scopes: ['openid'],
  accountUrl: '/admin/',
};
const web = new Hono().route(
  '/mail',
  createWebmail({ assets, configuration, mountedAt: '/mail' }),
);
const get = (path: string, headers: Record<string, string> = {}) =>
  web.request(`/mail${path === '/' ? '' : path}`, { headers });

describe('webmail', () => {
  it('serves the page for the webmail’s own addresses, and files by name', async () => {
    for (const path of ['/', '/box/abc', '/box/abc/t1', '/search?q=x']) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(await response.text()).toContain('<title>Mail</title>');
    }
    const script = await get('/assets/app-abc123.js', {
      'accept-encoding': 'gzip',
    });
    expect(script.headers.get('cache-control')).toContain('immutable');
    expect(script.headers.get('content-encoding')).toBe('gzip');
    expect((await get('/assets/missing.js')).status).toBe(404);
  });

  it('tells the pages where to sign in and where the mail is, and nothing secret', async () => {
    const response = await get('/config.json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(configuration);
  });

  it('lets no script in from anywhere else, and is shown in no frame', async () => {
    const headers = (await get('/')).headers;
    const policy = headers.get('content-security-policy') as string;
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(policy).toContain("connect-src 'self' https://auth.example.com;");
    expect(policy).toContain("frame-src 'self';");
    // A picture being put in a message is shown from the copy the browser holds of it.
    expect(policy).toMatch(/img-src [^;]*\bblob:/);
    expect(policy).not.toMatch(/(script|default|frame|connect)-src[^;]*blob:/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(webmailSecurityHeaders(configuration)).toMatchObject({
      'strict-transport-security': 'max-age=31536000',
    });
  });

  it('reads its configuration from the environment, and says what is missing', () => {
    const env = {
      WEBMAIL_CLIENT_ID: 'webmail-client',
      AUTH_AUTHORIZE_URL: configuration.authorizeUrl,
      AUTH_TOKEN_URL: configuration.tokenUrl,
      AUTH_LOGOUT_URL: configuration.logoutUrl,
      AUTH_REVOKE_URL: configuration.revokeUrl ?? '',
      AUTH_SCOPES: '["openid"]',
      ACCOUNT_URL: '/admin/',
    };
    expect(webmailConfigurationFromEnvironment(env)).toEqual(configuration);
    expect(
      webmailConfigurationFromEnvironment({ ...env, ACCOUNT_URL: '' })
        .accountUrl,
    ).toBeNull();
    // A provider with nowhere to take a token back is still one to sign in at.
    expect(
      webmailConfigurationFromEnvironment({ ...env, AUTH_REVOKE_URL: '' })
        .revokeUrl,
    ).toBeNull();
    expect(() =>
      webmailConfigurationFromEnvironment({ ...env, WEBMAIL_CLIENT_ID: '' }),
    ).toThrow('WEBMAIL_CLIENT_ID');
    expect(() =>
      webmailConfigurationFromEnvironment({ ...env, AUTH_SCOPES: '"openid"' }),
    ).toThrow('AUTH_SCOPES');
  });
});
