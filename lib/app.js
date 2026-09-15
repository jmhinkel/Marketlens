// Builds the Express app. Kept separate from server.js so the same routes can
// be served two ways: as a long-running local process, or wrapped as a single
// serverless function on Netlify.
//
// Nothing in here starts a listener or reads .env - the entry points do that,
// because they differ between the two environments.
import express from 'express';
import fs from 'node:fs';
import { runAnalysis } from './analyze.js';
import { synthesize, llmAvailable } from './llm.js';
import { analyzeCoveredCalls } from './options/covered.js';
import { searchSymbol, TIMEFRAMES } from './data/yahoo.js';
import { hasFredKey } from './data/fred.js';
import { installAuth, authEnabled, loginPageHtml } from './auth.js';
import { scanUniverse, UNIVERSES } from './scan.js';

// The static directory is passed in rather than derived from import.meta.url.
// Netlify bundles this module to CommonJS with esbuild, where import.meta.url
// is undefined - deriving a path here throws at module load and takes every
// route down with it. The local entry point knows its own location; the
// serverless one does not need static files at all, because the CDN serves
// them before the function is ever invoked.
export function createApp({ publicDir } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Registered BEFORE the auth gate on purpose: this is the endpoint you hit
  // to find out why a deployment is broken, and needing to log in first would
  // defeat that. It exposes nothing but whether two public feeds answered.
  installHealthCheck(app);

  // The gate is registered before the static handler so that locally it
  // protects the app shell too. On Netlify the CDN serves public/ before any
  // of this runs, so there the gate covers the API only - see README.
  installAuth(app, { loginPage: () => loginPageHtml() });

  // Only mounted when a directory is supplied and exists. On Netlify the
  // static assets are served by the CDN and never reach the function.
  if (publicDir && fs.existsSync(publicDir)) app.use(express.static(publicDir));

  app.get('/api/config', (req, res) => {
    res.json({
      llm: llmAvailable(),
      fred: hasFredKey(),
      auth: authEnabled(),
      universes: Object.entries(UNIVERSES).map(([id, u]) => ({ id, label: u.label, note: u.note, size: u.symbols.length })),
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
      res.json(await runAnalysis({ symbol, timeframe }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/scan', async (req, res) => {
    const universe = (req.query.universe || 'core').trim();
    const limit = Math.max(1, Math.min(10, Number(req.query.limit) || 6));
    if (!UNIVERSES[universe]) {
      return res.status(400).json({
        error: `unknown universe ${universe}`,
        available: Object.keys(UNIVERSES),
      });
    }
    try {
      res.json(await scanUniverse({ universe, limit }));
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
  // immediately and the prose arrives behind them.
  app.post('/api/narrative', async (req, res) => {
    const { symbol, timeframe = '1d', question } = req.body || {};
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    try {
      const analysis = await runAnalysis({ symbol, timeframe });
      res.json(await synthesize(analysis, { question }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return app;
}

// Confirms the upstream feeds are reachable from wherever this is running.
// This is the check that tells you whether a cloud host's IP is being refused
// by Yahoo or CBOE.
function installHealthCheck(app) {
  app.get('/api/health', async (req, res) => {
    const probes = {
      yahoo: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d',
      cboe: 'https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json',
    };
    const out = {};
    await Promise.all(
      Object.entries(probes).map(async ([name, url]) => {
        const started = Date.now();
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });
          out[name] = { ok: r.ok, status: r.status, ms: Date.now() - started };
        } catch (err) {
          out[name] = { ok: false, error: err.message, ms: Date.now() - started };
        }
      })
    );
    const healthy = Object.values(out).every((v) => v.ok);
    res.status(healthy ? 200 : 503).json({
      healthy,
      note: healthy
        ? 'Both price feeds are reachable from this host.'
        : 'A price feed is blocked or failing from this host. If this is a cloud deployment, the datacenter IP is likely being refused.',
      probes: out,
    });
  });
}
