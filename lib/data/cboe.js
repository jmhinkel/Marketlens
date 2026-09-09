// Options chains from CBOE's public delayed-quote feed. No key, no crumb, and
// it ships greeks and implied vol per contract, so we never have to price
// options ourselves.
//
// Quotes are delayed (typically 15 minutes). That is fine for strike selection
// and completely unsuitable for timing an execution - the UI says so.
import { cached } from '../cache.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// Assets with no listed options at all (futures, spot crypto, FX, indices we
// cannot trade directly) mapped to the liquid instruments people actually sell
// calls on. Ordered most liquid first.
export const OPTIONABLE_PROXIES = {
  'HG=F': [
    { symbol: 'FCX', note: 'Freeport-McMoRan - the highest-volume copper options in the US' },
    { symbol: 'COPX', note: 'Global X Copper Miners ETF' },
    { symbol: 'CPER', note: 'US Copper Index Fund - tracks the futures curve directly' },
  ],
  'GC=F': [
    { symbol: 'GLD', note: 'SPDR Gold Shares - deepest gold options' },
    { symbol: 'IAU', note: 'iShares Gold Trust - cheaper contracts, thinner chain' },
    { symbol: 'GDX', note: 'Gold miners - higher beta and richer premium' },
  ],
  'SI=F': [{ symbol: 'SLV', note: 'iShares Silver Trust' }, { symbol: 'SIL', note: 'Silver miners' }],
  'CL=F': [
    { symbol: 'USO', note: 'United States Oil Fund' },
    { symbol: 'XLE', note: 'Energy sector - equity exposure rather than the barrel' },
  ],
  'NG=F': [{ symbol: 'UNG', note: 'United States Natural Gas Fund' }],
  'ZC=F': [{ symbol: 'CORN', note: 'Teucrium Corn Fund - thin chain, check spreads' }],
  'ZW=F': [{ symbol: 'WEAT', note: 'Teucrium Wheat Fund - thin chain' }],
  'ZS=F': [{ symbol: 'SOYB', note: 'Teucrium Soybean Fund - thin chain' }],
  'BTC-USD': [
    { symbol: 'IBIT', note: 'iShares Bitcoin Trust - now the deepest listed bitcoin options' },
    { symbol: 'MSTR', note: 'Strategy - leveraged proxy, far richer premium and far more risk' },
  ],
  'ETH-USD': [{ symbol: 'ETHA', note: 'iShares Ethereum Trust' }],
  '^GSPC': [{ symbol: 'SPY', note: 'SPDR S&P 500 - the most liquid options in the world' }],
  '^NDX': [{ symbol: 'QQQ', note: 'Invesco QQQ' }],
  '^DJI': [{ symbol: 'DIA', note: 'SPDR Dow Jones' }],
  '^RUT': [{ symbol: 'IWM', note: 'iShares Russell 2000' }],
  'ES=F': [{ symbol: 'SPY', note: 'SPDR S&P 500' }],
  'NQ=F': [{ symbol: 'QQQ', note: 'Invesco QQQ' }],
};

// OCC symbols are ROOT + YYMMDD + C/P + strike*1000 (8 digits). Parse from the
// right so roots containing digits still work.
function parseOccSymbol(sym) {
  if (!sym || sym.length < 16) return null;
  const strikeRaw = sym.slice(-8);
  const type = sym.slice(-9, -8);
  const date = sym.slice(-15, -9);
  const root = sym.slice(0, -15);
  if (!/^\d{8}$/.test(strikeRaw) || !/^[CP]$/.test(type) || !/^\d{6}$/.test(date)) return null;
  return {
    root,
    type: type === 'C' ? 'call' : 'put',
    strike: Number(strikeRaw) / 1000,
    expiry: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
  };
}

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export async function fetchChain(symbol) {
  const sym = symbol.toUpperCase();
  return cached(`cboe:${sym}`, 300_000, async () => {
    const res = await fetch(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }
    );
    // CBOE answers 403 as well as 404 for symbols it does not list - futures,
    // spot crypto and FX all land here. Both mean the same thing to us.
    if (res.status === 404 || res.status === 403) {
      const err = new Error(`No listed options for ${sym}.`);
      err.code = 'NO_OPTIONS';
      throw err;
    }
    if (!res.ok) throw new Error(`CBOE returned HTTP ${res.status} for ${sym}`);

    const json = await res.json();
    const spot = num(json?.data?.current_price);
    const raw = json?.data?.options || [];
    if (!spot || !raw.length) {
      const err = new Error(`No listed options for ${sym}.`);
      err.code = 'NO_OPTIONS';
      throw err;
    }

    const contracts = [];
    for (const o of raw) {
      const parsed = parseOccSymbol(o.option);
      if (!parsed) continue;
      contracts.push({
        occ: o.option,
        ...parsed,
        bid: num(o.bid),
        ask: num(o.ask),
        last: num(o.last_trade_price),
        iv: num(o.iv),
        delta: num(o.delta),
        gamma: num(o.gamma),
        theta: num(o.theta),
        vega: num(o.vega),
        openInterest: num(o.open_interest) ?? 0,
        volume: num(o.volume) ?? 0,
      });
    }

    // Group by expiry so the caller can pick a tenor.
    const byExpiry = new Map();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (const c of contracts) {
      if (!byExpiry.has(c.expiry)) {
        const dte = Math.round((new Date(`${c.expiry}T00:00:00Z`) - today) / 86_400_000);
        byExpiry.set(c.expiry, { expiry: c.expiry, dte, calls: [], puts: [] });
      }
      byExpiry.get(c.expiry)[c.type === 'call' ? 'calls' : 'puts'].push(c);
    }

    const expiries = [...byExpiry.values()]
      .filter((e) => e.dte >= 0)
      .sort((a, b) => a.dte - b.dte);
    for (const e of expiries) {
      e.calls.sort((a, b) => a.strike - b.strike);
      e.puts.sort((a, b) => a.strike - b.strike);
    }

    return { symbol: sym, spot, expiries, fetchedAt: new Date().toISOString() };
  });
}

// The expiry closest to a target holding period. 30-45 days is the usual
// covered-call window: enough premium to be worth it, fast enough theta decay.
export function pickExpiry(chain, targetDte = 35) {
  const usable = chain.expiries.filter((e) => e.dte >= 7 && e.calls.length >= 4);
  if (!usable.length) return chain.expiries[0] || null;
  return usable.reduce((best, e) =>
    Math.abs(e.dte - targetDte) < Math.abs(best.dte - targetDte) ? e : best
  );
}
