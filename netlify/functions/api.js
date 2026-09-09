// Netlify entry point. The whole Express app runs as one serverless function;
// netlify.toml rewrites /api/* and /login onto it.
//
// basePath strips Netlify's function prefix so Express sees the original path
// (/api/analyze rather than /.netlify/functions/api/api/analyze).
import serverless from 'serverless-http';
import { createApp } from '../../lib/app.js';

// Built once per container and reused across invocations on a warm start.
const app = createApp();

export const handler = serverless(app, {
  basePath: '/.netlify/functions/api',
  // Netlify already decodes the body; hand Express the raw request as-is.
  request(req, event) {
    // Preserve the client IP so the login rate limiter has something real to
    // key on. Behind Netlify this arrives as x-nf-client-connection-ip.
    const ip = event.headers?.['x-nf-client-connection-ip'];
    if (ip && !req.headers['x-forwarded-for']) req.headers['x-forwarded-for'] = ip;
  },
});
