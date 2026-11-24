// Option chains from Nasdaq's public quote API. No key.
//
// WHY THIS REPLACED CBOE
//
// CBOE's delayed-quote feed was the source until November 2026, when it moved
// to cdn-api.cboe.com behind Cloudflare bot protection and began answering 403
// to this server. That is an access control its operator chose to add, so it
// is not something to be worked around; the feed is simply gone.
//
// WHAT IS LOST, AND WHAT IS DONE ABOUT IT
//
// CBOE shipped implied volatility and all four greeks per contract. Nasdaq
// ships bid, ask, last, volume, open interest, strike and expiry - and nothing
// else. Since every piece of options analysis in this app is built on implied
// vol, it is recovered by inverting Black-Scholes on the mid price, and the
// greeks are computed from that. lib/options/blackscholes.js does the work and
// tools/validate-greeks.mjs checks it round-trips.
//
// This is not a degradation so much as a relocation: CBOE was inverting the
// same formula and handing over the answer. What genuinely changes is that the
// assumptions are now ours and are stated - European exercise, no dividend
// yield, mid-price input - rather than being whatever CBOE chose.
//
// TWO QUIRKS OF THE FEED, BOTH HANDLED BELOW
//
//   * assetclass must be exactly right. SPY as 'stocks' returns "Symbol not
//     exists", which looks like a delisting and is not one. The class comes
//     from Yahoo's instrumentType, which the app already fetches.
//   * Row dates are formatted "Dec 1" with no year, which is ambiguous across
//     a year boundary. The unambiguous date is in drillDownURL, which carries
//     the OCC code - so that is what gets parsed.
import { cached } from '../cache.js';
import { fetchSeries } from './yahoo.js';
import { riskFreeRate } from './rates.js';
import { impliedVol, bsGreeks } from '../options/blackscholes.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// How far out to pull, and how many rows to allow.
//
// Both matter more than they look. Nasdaq truncates to `limit` rows ordered by
// expiry, so an under-sized limit does not thin the chain evenly - it silently
// drops the far expiries. At limit 1200 SPY returned only its first 6
// expiries, all inside 17 days, and pickExpiry then "found" an 8-day contract
// for a 35-day target without anything looking wrong.
//
// Measured on SPY, the widest chain in the universe:
//
//     window   rows   expiries   furthest   payload   time
//      45d     2585      13         38d      997KB   1014ms
//      75d     3054      15         67d     1178KB   1121ms
//     130d     3709      19        128d     1431KB   1324ms
//
// 75 days covers the long-calls panel's 60-day target with room, keeps one
// cached chain serving all three panels plus the scanner, and costs about a
// second. The limit is set well clear of the row count so truncation cannot
// creep back in as chains grow.
const WINDOW_DAYS = 75;
const ROW_LIMIT = 5000;

const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$,]/g, '').trim();
  if (s === '' || s === '--' || s === 'N/A') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Yahoo's instrumentType decides Nasdaq's assetclass. Getting this wrong is
// indistinguishable from the symbol not existing, so unknown types are tried
// as stocks first and then as an ETF rather than guessed at once.
function assetClassesFor(quoteType) {
  const t = String(quoteType || '').toUpperCase();
  if (t === 'ETF' || t === 'MUTUALFUND') return ['etf'];
  if (t === 'EQUITY') return ['stocks'];
  if (t === 'INDEX') return ['index'];
  return ['stocks', 'etf'];
}

// drillDownURL ends with an OCC-style code: YYMMDD, then c or p, then the
// strike in thousandths. The row's own "Dec 1" has no year and cannot be
// trusted near a December/January boundary, so this is the only safe source.
//
// The separator before the code is NOT fixed - SPY gives "spy---261201c...",
// NVDA gives "nvda--261125c...", because the root is padded to a constant
// width. Splitting on "---" therefore works for three-letter symbols and
// silently returns nothing for four-letter ones, which is how NVDA came back
// as having no listed options while SPY was fine. Matching the code at the
// END of the string is indifferent to whatever precedes it.
function parseDrillDown(url) {
  if (!url) return null;
  const m = /(\d{6})([cp])(\d{8})$/i.exec(String(url));
  if (!m) return null;
  const [, yymmdd, , strikeRaw] = m;
  return {
    expiry: `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`,
    yymmdd,
    strike: Number(strikeRaw) / 1000,
  };
}

const occFor = (root, yymmdd, type, strike) =>
  `${root}${yymmdd}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

const iso = (d) => d.toISOString().slice(0, 10);

async function fetchRows(sym, assetclass, from, to) {
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/option-chain` +
    `?assetclass=${assetclass}&limit=${ROW_LIMIT}&fromdate=${from}&todate=${to}` +
    `&excode=oprac&callput=callput&money=all&type=all`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const err = new Error(`Nasdaq options feed returned HTTP ${res.status} for ${sym}.`);
    err.code = res.status === 403 || res.status === 429 ? 'FEED_BLOCKED' : 'FEED_ERROR';
    throw err;
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const err = new Error(
      `The Nasdaq options feed returned a web page instead of data, which means it is blocking ` +
      `this server rather than answering about ${sym}.`
    );
    err.code = 'FEED_BLOCKED';
    throw err;
  }
  return res.json();
}

// Only two window sizes exist, so that a 35-day strategy and a 60-day one do
// not each pull their own copy of every chain. Rounding into buckets keeps the
// cache shared between the covered-call and put panels, which both want 35
// days, while the long-calls panel gets the wider pull it actually needs.
const windowFor = (maxDte) => (maxDte != null && maxDte <= 45 ? 50 : WINDOW_DAYS);

export async function fetchChain(symbol, { maxDte = null } = {}) {
  const sym = symbol.toUpperCase();
  const windowDays = windowFor(maxDte);
  return cached(`chain:${sym}:${windowDays}`, 300_000, async () => {
    // Spot comes from Yahoo, not from Nasdaq's lastTrade field, which lags by
    // a session on many symbols. Yahoo is already the price backbone for the
    // whole app and is cached, so this is free on the normal path.
    const series = await fetchSeries(sym, '1d');
    const spot = series.meta?.price ?? series.bars.at(-1)?.close;
    if (!(spot > 0)) {
      const err = new Error(`No usable spot price for ${sym}.`);
      err.code = 'NO_OPTIONS';
      throw err;
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const to = new Date(today.getTime() + windowDays * 86_400_000);

    let json = null;
    let used = null;
    for (const cls of assetClassesFor(series.meta?.quoteType)) {
      const attempt = await fetchRows(sym, cls, iso(today), iso(to));
      if (attempt?.data?.table?.rows?.length) { json = attempt; used = cls; break; }
    }
    if (!json) {
      const err = new Error(`No listed options for ${sym}.`);
      err.code = 'NO_OPTIONS';
      throw err;
    }

    const rf = await riskFreeRate();
    const r = rf.annualPct / 100;
    const root = sym.replace(/[^A-Z0-9]/g, '');

    const contracts = [];
    for (const row of json.data.table.rows) {
      const d = parseDrillDown(row.drillDownURL);
      if (!d) continue; // group header rows carry no code
      const strike = d.strike || num(row.strike);
      if (!(strike > 0)) continue;

      const dte = Math.round((new Date(`${d.expiry}T00:00:00Z`) - today) / 86_400_000);
      if (dte < 0) continue;
      // Year fraction for pricing. Same-day expiries would divide by zero, so
      // they are floored at a few hours rather than dropped - the panels
      // filter by tenor anyway.
      const T = Math.max(dte, 0.25) / 365;

      for (const type of ['call', 'put']) {
        const p = type === 'call' ? 'c' : 'p';
        const bid = num(row[`${p}_Bid`]);
        const ask = num(row[`${p}_Ask`]);
        const last = num(row[`${p}_Last`]);
        // No two-sided market means no mid, and a one-sided quote cannot be
        // inverted honestly. These are dropped rather than guessed at.
        if (bid == null || ask == null || !(ask > 0)) continue;

        const mid = (bid + ask) / 2;
        const isCall = type === 'call';
        const iv = mid > 0 ? impliedVol(mid, spot, strike, T, r, isCall) : null;
        const greeks = iv != null
          ? bsGreeks(spot, strike, T, r, iv, isCall)
          : { delta: null, gamma: null, theta: null, vega: null };

        contracts.push({
          occ: occFor(root, d.yymmdd, type, strike),
          root,
          type,
          strike,
          expiry: d.expiry,
          bid,
          ask,
          last,
          iv,
          ...greeks,
          openInterest: num(row[`${p}_Openinterest`]) ?? 0,
          volume: num(row[`${p}_Volume`]) ?? 0,
          // Flagged so nothing downstream mistakes a derived number for a
          // quoted one.
          derived: true,
        });
      }
    }

    if (!contracts.length) {
      const err = new Error(`No listed options for ${sym}.`);
      err.code = 'NO_OPTIONS';
      throw err;
    }

    const byExpiry = new Map();
    for (const c of contracts) {
      if (!byExpiry.has(c.expiry)) {
        const dte = Math.round((new Date(`${c.expiry}T00:00:00Z`) - today) / 86_400_000);
        byExpiry.set(c.expiry, { expiry: c.expiry, dte, calls: [], puts: [] });
      }
      byExpiry.get(c.expiry)[c.type === 'call' ? 'calls' : 'puts'].push(c);
    }

    const expiries = [...byExpiry.values()].filter((e) => e.dte >= 0).sort((a, b) => a.dte - b.dte);
    for (const e of expiries) {
      e.calls.sort((a, b) => a.strike - b.strike);
      e.puts.sort((a, b) => a.strike - b.strike);
    }

    return {
      symbol: sym,
      spot,
      expiries,
      fetchedAt: new Date().toISOString(),
      provider: 'nasdaq',
      assetClass: used,
      // Surfaced so the UI can be honest that these are computed, and on what
      // assumptions.
      greeksDerived: true,
      riskFreeUsed: rf.annualPct,
      quoteNote: json.data?.lastTrade || null,
    };
  });
}
