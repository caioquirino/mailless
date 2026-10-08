import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';

/*
 * Serves a web application that was built into the function's own bundle: a
 * handful of static files, and the configuration its pages read on starting.
 * The pages are public, as the files of any web application are; whatever
 * they do goes through an API that is not.
 */

/** The files of a built application, by path. Text is kept compressed. */
export type WebAssets = Record<
  string,
  { type: string; gzip: boolean; body: string }
>;

export interface SiteOptions {
  assets: WebAssets;
  /** What the pages are told on starting, served as `config.json`. Nothing in it is secret. */
  configuration: unknown;
  /** The headers every answer is sent with: what the pages may load and from where. */
  headers: Record<string, string>;
  /** Where the application is mounted, such as `/admin`: a file's path is what follows it. */
  mountedAt?: string;
}

/** The origin of an address, or undefined when it is not one. */
export function origin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The application, to mount where its pages expect to be. */
export function createSite(options: SiteOptions): Hono {
  const { assets, configuration, headers } = options;
  const mountedAt = (options.mountedAt ?? '').replace(/\/+$/, '');
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) {
      c.header(name, value);
    }
  });

  app.get('/config.json', (c) => {
    // Never kept: a deployment that changes its sign-in settings is believed at once.
    c.header('cache-control', 'no-store');
    return c.json(configuration);
  });

  app.get('*', (c) => {
    const requested = c.req.path;
    const path = (
      mountedAt && requested.startsWith(mountedAt)
        ? requested.slice(mountedAt.length)
        : requested
    ).replace(/^\/+/, '');
    // Anything that is not a file is an address inside the interface, which the pages work out themselves.
    const isFile = Object.prototype.hasOwnProperty.call(assets, path);
    const name = isFile ? path : 'index.html';
    const asset = assets[name];
    if (!asset || (!isFile && /\.[a-z0-9]+$/i.test(path))) {
      // A file that is asked for by name and is not there is not there.
      return c.text('Not found', 404);
    }

    c.header('content-type', asset.type);
    c.header(
      'cache-control',
      // Built files carry a digest of their content in their name, so they never change.
      name.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    );
    const data = Buffer.from(asset.body, 'base64');
    if (!asset.gzip) return c.body(new Uint8Array(data));
    c.header('vary', 'accept-encoding');
    if (/\bgzip\b/.test(c.req.header('accept-encoding') ?? '')) {
      c.header('content-encoding', 'gzip');
      return c.body(new Uint8Array(data));
    }
    return c.body(new Uint8Array(gunzipSync(data)));
  });

  return app;
}
