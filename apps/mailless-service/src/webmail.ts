import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { assets } from './webmail/web-assets.gen.js';
import {
  createWebmail,
  webmailConfigurationFromEnvironment,
} from './webmail/web.js';

// The pages of the webmail are part of this function's own bundle. It hands
// them out and does nothing else: it holds no mail and may reach none.
const web = createWebmail({
  assets,
  configuration: webmailConfigurationFromEnvironment(process.env),
  mountedAt: '/mail',
});

/**
 * The webmail under /mail, next to the JMAP API it is a client of. Someone
 * who asks for the site itself is shown the way.
 */
export const handler = handle(
  new Hono()
    .get('/', (c) => c.redirect('/mail/', 302))
    .route('/mail', web)
    .notFound((c) => c.text('Not found', 404)),
);
