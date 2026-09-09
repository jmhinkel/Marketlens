import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAnalysis } from './lib/analyze.js';
import { synthesize, llmAvailable } from './lib/llm.js';
import { analyzeCoveredCalls } from './lib/options/covered.js';
import { searchSymbol, TIMEFRAMES } from './lib/data/yahoo.js';
import { hasFredKey } from './lib/data/fred.js';
import { installAuth, authEnabled, loginPageHtml } from './lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader so the app runs from a double-clicked shortcut without
// needing the key exported in the shell.
const envPath = path.join(here, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// The gate goes in before the static handler, so the app shell itself is
// protected and not just the API. Everything registered below this line
// requires a session when APP_PASSWORD is set.
installAuth(app, { loginPage: () => loginPageHtml() });

app.use(express.static(path.join(here, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    llm: llmAvailable(),
    fred: hasFredKey(),
    auth: authEnabled(),
    timeframes: Object.entries(TIMEFRAMES).map(([k, v]) => ({ id: k, label: v.label })),
  });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json({ results: [] });
  try {
    res.json({ results: await searchSymbol(q) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/analyze', async (req, res) => {
  const symbol = (req.query.symbol || '').trim();
  const timeframe = (req.query.timeframe || '1d').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  if (!TIMEFRAMES[timeframe]) return res.status(400).json({ error: `unknown timeframe ${timeframe}` });

  try {
    const analysis = await runAnalysis({ symbol, timeframe });
    res.json(analysis);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/covered', async (req, res) => {
  const symbol = (req.query.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  const expiry = (req.query.expiry || '').trim() || undefined;
  const targetDte = Number(req.query.targetDte) || 35;
  try {
    res.json(await analyzeCoveredCalls({ symbol, expiry, targetDte }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// The written briefing is a separate call so the chart and the numbers paint
// immediately and the prose streams in behind them.
app.post('/api/narrative', async (req, res) => {
  const { symbol, timeframe = '1d', question } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  try {
    const analysis = await runAnalysis({ symbol, timeframe });
    const result = await synthesize(analysis, { question });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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
