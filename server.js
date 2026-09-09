// Local entry point: loads .env, then runs the app as a normal long-lived
// server. The Netlify entry point is netlify/functions/api.js and shares the
// exact same routes via createApp().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.js';
import { llmAvailable } from './lib/llm.js';
import { hasFredKey } from './lib/data/fred.js';
import { authEnabled } from './lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader so the app runs from a double-clicked shortcut without
// needing the keys exported in the shell. Hosted environments inject their
// own environment variables instead, so a missing file is fine.
const envPath = path.join(here, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const app = createApp();
const port = Number(process.env.PORT) || 5178;

app.listen(port, () => {
  console.log(`\n  Market Lens running at http://localhost:${port}`);
  console.log(`  Anthropic key: ${llmAvailable() ? 'configured' : 'MISSING (written analysis disabled)'}`);
  console.log(`  FRED key:      ${hasFredKey() ? 'configured' : 'not set (macro layer uses market proxies)'}`);
  if (authEnabled()) {
    console.log('  Password:      set - the app is gated\n');
  } else {
    console.log('\n  !! NO PASSWORD SET. Anyone who can reach this port has full access,');
    console.log('     including the Anthropic key behind /api/narrative.');
    console.log('     Fine on localhost. Set APP_PASSWORD in .env before exposing it.\n');
  }
});
