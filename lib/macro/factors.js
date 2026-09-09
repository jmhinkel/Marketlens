// Computes the macro factor readings that the asset profiles weight.
//
// Every factor resolves to a `stance` in -1..+1 describing the FACTOR's own
// direction, never the asset's. "dollar: +0.6" means the dollar is
// strengthening; whether that is good or bad for what you are looking at is
// decided by the sign in the asset profile.
import { fetchDailyCloses } from '../data/yahoo.js';
import { fredSeries, treasuryCurve, hasFredKey } from '../data/fred.js';

// Market proxies, all keyless via Yahoo.
export const PROXIES = {
  dxy: 'DX-Y.NYB',
  us10y: '^TNX',
  us5y: '^FVX',
  vix: '^VIX',
  hyg: 'HYG',
  lqd: 'LQD',
  ief: 'IEF',
  tip: 'TIP',
  industrials: 'XLI',
  utilities: 'XLU',
  crude: 'CL=F',
  china: 'FXI',
  korea: 'EWY',
  gold: 'GLD',
  spx: 'SPY',
  defense: 'ITA',
  btcEtf: 'IBIT',
  eth: 'ETH-USD',
};

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
// Squash an unbounded z-score into -1..+1 without hard clipping the middle.
const squash = (z) => (z == null ? null : clamp(Math.tanh(z / 1.75)));

function values(map) {
  if (!map) return [];
  return Object.keys(map).sort().map((k) => map[k]);
}

function momentum(map, days) {
  const v = values(map);
  if (v.length <= days) return null;
  const now = v.at(-1);
  const then = v.at(-1 - days);
  if (then == null || then === 0) return null;
  return ((now - then) / Math.abs(then)) * 100;
}

// Level of the latest reading relative to its own last year.
function levelZ(map, lookback = 252) {
  const v = values(map).slice(-lookback).filter(Number.isFinite);
  if (v.length < 40) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return sd === 0 ? 0 : (v.at(-1) - mean) / sd;
}

// Momentum expressed in standard deviations of that series' own 3-month moves,
// so a 2% move in the dollar and a 2% move in crude are scored on their own
// scales rather than treated as equivalent.
function momentumZ(map, days = 63) {
  const v = values(map);
  if (v.length < days * 3) return null;
  const changes = [];
  for (let i = days; i < v.length; i++) {
    if (v[i - days] === 0 || v[i - days] == null) continue;
    changes.push(((v[i] - v[i - days]) / Math.abs(v[i - days])) * 100);
  }
  if (changes.length < 40) return null;
  const cur = changes.at(-1);
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const sd = Math.sqrt(changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length);
  return sd === 0 ? 0 : (cur - mean) / sd;
}

// Element-wise ratio of two close maps on their shared dates - used for
// relative-strength pairs like industrials vs utilities.
function ratioSeries(a, b) {
  if (!a || !b) return null;
  const out = {};
  for (const d of Object.keys(a)) {
    if (b[d] && b[d] !== 0) out[d] = a[d] / b[d];
  }
  return Object.keys(out).length > 60 ? out : null;
}

const avg = (list) => {
  const clean = list.filter((v) => v != null && Number.isFinite(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
};

const fmt = (v, digits = 2, suffix = '') =>
  v == null ? 'n/a' : `${v > 0 && suffix === '%' ? '+' : ''}${v.toFixed(digits)}${suffix}`;

export async function loadMacroInputs() {
  const entries = await Promise.all(
    Object.entries(PROXIES).map(async ([key, symbol]) => {
      try {
        return [key, await fetchDailyCloses(symbol, 3)];
      } catch {
        return [key, null];
      }
    })
  );
  const market = Object.fromEntries(entries);

  // FRED series are optional; each returns null without a key.
  const [dfii10, t10y2y, t5yie, walcl, m2, indpro, hySpread] = await Promise.all([
    fredSeries('DFII10'),       // 10y TIPS - the real rate
    fredSeries('T10Y2Y'),       // curve slope
    fredSeries('T5YIE'),        // 5y inflation breakeven
    fredSeries('WALCL'),        // Fed balance sheet
    fredSeries('M2SL'),         // money supply
    fredSeries('INDPRO'),       // industrial production
    fredSeries('BAMLH0A0HYM2'), // high yield OAS
  ]);
  const curve = t10y2y ? null : await treasuryCurve();

  return { market, fred: { dfii10, t10y2y, t5yie, walcl, m2, indpro, hySpread }, curve, hasFred: hasFredKey() };
}

// --- Individual factors ---------------------------------------------------
// Each returns: stance, confidence, headline value, and the reasoning shown
// in the UI. `proxy` names the series used for the empirical correlation pass.

function realRates({ market, fred }) {
  if (fred.dfii10) {
    const v = values(fred.dfii10);
    const level = v.at(-1);
    const chg = momentum(fred.dfii10, 63);
    const z = levelZ(fred.dfii10);
    const stance = clamp((squash(z) ?? 0) * 0.6 + clamp((chg ?? 0) / 25) * 0.4);
    return {
      stance,
      confidence: 'high',
      value: `${level.toFixed(2)}% 10y TIPS`,
      detail: `Real 10-year yield at ${level.toFixed(2)}%, ${chg == null ? 'flat' : chg > 0 ? 'up' : 'down'} over three months. ${z != null ? `That is ${Math.abs(z).toFixed(1)} standard deviations ${z > 0 ? 'above' : 'below'} its one-year average.` : ''}`,
      source: 'FRED DFII10',
      proxy: 'us10y',
    };
  }
  // Without FRED, the nominal 10-year is the available stand-in.
  const z = levelZ(market.us10y);
  const chg = momentum(market.us10y, 63);
  return {
    stance: clamp((squash(z) ?? 0) * 0.6 + clamp((chg ?? 0) / 25) * 0.4),
    confidence: 'proxy',
    value: market.us10y ? `${values(market.us10y).at(-1).toFixed(2)}% nominal 10y` : 'n/a',
    detail: `Using the nominal 10-year yield as a stand-in for the real rate. Add a FRED key to score the actual TIPS yield.`,
    source: 'Yahoo ^TNX (proxy)',
    proxy: 'us10y',
  };
}

function dollar({ market }) {
  const z = momentumZ(market.dxy);
  const chg = momentum(market.dxy, 63);
  const lz = levelZ(market.dxy);
  return {
    stance: clamp((squash(z) ?? 0) * 0.7 + (squash(lz) ?? 0) * 0.3),
    confidence: market.dxy ? 'high' : 'unavailable',
    value: market.dxy ? values(market.dxy).at(-1).toFixed(2) : 'n/a',
    detail: `Dollar index ${fmt(chg, 1, '%')} over three months${lz != null ? `, sitting ${Math.abs(lz).toFixed(1)}sd ${lz > 0 ? 'above' : 'below'} its one-year mean` : ''}.`,
    source: 'Yahoo DX-Y.NYB',
    proxy: 'dxy',
  };
}

function yieldCurve({ fred, curve, market }) {
  if (fred.t10y2y) {
    const v = values(fred.t10y2y);
    const spread = v.at(-1);
    const chg3m = spread - (v.at(-64) ?? spread);
    return {
      stance: clamp(chg3m / 0.5),
      confidence: 'high',
      value: `${spread.toFixed(2)}pp 10y-2y`,
      detail: `The 10s-2s spread is ${spread.toFixed(2)} points (${spread < 0 ? 'inverted' : 'positive'}) and has ${chg3m > 0 ? 'steepened' : 'flattened'} ${Math.abs(chg3m).toFixed(2)} points in three months.`,
      source: 'FRED T10Y2Y',
      proxy: null,
    };
  }
  if (curve?.length) {
    const spread = curve.at(-1).spread;
    const past = curve[Math.max(0, curve.length - 64)].spread;
    const chg3m = spread - past;
    return {
      stance: clamp(chg3m / 0.5),
      confidence: 'high',
      value: `${spread.toFixed(2)}pp 10y-2y`,
      detail: `The 10s-2s spread is ${spread.toFixed(2)} points (${spread < 0 ? 'inverted' : 'positive'}) and has ${chg3m > 0 ? 'steepened' : 'flattened'} ${Math.abs(chg3m).toFixed(2)} points in three months.`,
      source: 'US Treasury daily par yield curve',
      proxy: null,
    };
  }
  // Last resort: the 10y vs 5y shape from Yahoo's yield indices.
  const spread = market.us10y && market.us5y
    ? values(market.us10y).at(-1) - values(market.us5y).at(-1)
    : null;
  return {
    stance: spread == null ? 0 : clamp(spread / 0.5),
    confidence: 'proxy',
    value: spread == null ? 'n/a' : `${spread.toFixed(2)}pp 10y-5y`,
    detail: 'Using the 10y-5y shape from Yahoo yield indices; the 2-year point was unavailable.',
    source: 'Yahoo ^TNX / ^FVX (proxy)',
    proxy: null,
  };
}

function globalGrowth({ market, fred }) {
  const cyclicals = ratioSeries(market.industrials, market.utilities);
  const credit = ratioSeries(market.hyg, market.ief);
  const cycZ = momentumZ(cyclicals);
  const creditZ = momentumZ(credit);
  let indproYoY = null;
  if (fred.indpro) {
    const v = values(fred.indpro);
    if (v.length > 12) indproYoY = ((v.at(-1) - v.at(-13)) / v.at(-13)) * 100;
  }
  const stance = clamp(
    avg([squash(cycZ), squash(creditZ), indproYoY == null ? null : clamp(indproYoY / 3)]) ?? 0
  );
  const parts = [];
  if (cycZ != null) parts.push(`industrials vs utilities ${cycZ > 0 ? 'leading' : 'lagging'}`);
  if (creditZ != null) parts.push(`high yield ${creditZ > 0 ? 'outperforming' : 'underperforming'} Treasuries`);
  if (indproYoY != null) parts.push(`industrial production ${fmt(indproYoY, 1, '%')} year over year`);
  return {
    stance,
    confidence: indproYoY != null ? 'high' : 'medium',
    value: stance > 0.25 ? 'expanding' : stance < -0.25 ? 'contracting' : 'flat',
    detail: parts.length ? `Cycle read from ${parts.join(', ')}.` : 'Insufficient data for a cycle read.',
    source: indproYoY != null ? 'FRED INDPRO + sector relative strength' : 'Sector and credit relative strength',
    proxy: 'industrials',
  };
}

function chinaGrowth({ market }) {
  const chinaZ = momentumZ(market.china);
  const koreaZ = momentumZ(market.korea);
  const stance = clamp(avg([squash(chinaZ), squash(koreaZ) * 0.6]) ?? 0);
  return {
    stance,
    confidence: 'medium',
    value: stance > 0.25 ? 'accelerating' : stance < -0.25 ? 'decelerating' : 'flat',
    detail: `Chinese equities ${fmt(momentum(market.china, 63), 1, '%')} and Korean equities ${fmt(momentum(market.korea, 63), 1, '%')} over three months - both read on Asian industrial demand. This is a market-implied proxy, not official activity data.`,
    source: 'Yahoo FXI, EWY',
    proxy: 'china',
  };
}

function liquidity({ market, fred }) {
  if (fred.walcl || fred.m2) {
    const balChg = fred.walcl ? momentum(fred.walcl, 13) : null; // weekly series
    let m2YoY = null;
    if (fred.m2) {
      const v = values(fred.m2);
      if (v.length > 12) m2YoY = ((v.at(-1) - v.at(-13)) / v.at(-13)) * 100;
    }
    const stance = clamp(avg([
      balChg == null ? null : clamp(balChg / 2),
      m2YoY == null ? null : clamp((m2YoY - 4) / 4),
    ]) ?? 0);
    return {
      stance,
      confidence: 'high',
      value: stance > 0.2 ? 'expanding' : stance < -0.2 ? 'draining' : 'neutral',
      detail: `Fed balance sheet ${fmt(balChg, 1, '%')} over a quarter${m2YoY == null ? '' : `, M2 growing ${m2YoY.toFixed(1)}% year over year`}.`,
      source: 'FRED WALCL, M2SL',
      proxy: null,
    };
  }
  // Proxy: credit willingness and a weaker dollar both accompany easier
  // financial conditions. Directionally useful, not a substitute.
  const credit = ratioSeries(market.hyg, market.lqd);
  const creditZ = momentumZ(credit);
  const dxyZ = momentumZ(market.dxy);
  const stance = clamp(avg([squash(creditZ), dxyZ == null ? null : -squash(dxyZ)]) ?? 0);
  return {
    stance,
    confidence: 'proxy',
    value: stance > 0.2 ? 'easing' : stance < -0.2 ? 'tightening' : 'neutral',
    detail: 'Financial-conditions proxy built from credit risk appetite and the dollar. Add a FRED key to score the Fed balance sheet and M2 directly.',
    source: 'HYG/LQD and DXY (proxy)',
    proxy: null,
  };
}

function riskAppetite({ market, fred }) {
  const vixZ = levelZ(market.vix);
  const credit = ratioSeries(market.hyg, market.lqd);
  const creditZ = momentumZ(credit);
  let spreadZ = null;
  if (fred.hySpread) spreadZ = levelZ(fred.hySpread);
  const stance = clamp(
    avg([
      vixZ == null ? null : -squash(vixZ),
      squash(creditZ),
      spreadZ == null ? null : -squash(spreadZ),
    ]) ?? 0
  );
  const vixNow = market.vix ? values(market.vix).at(-1) : null;
  return {
    stance,
    confidence: spreadZ != null ? 'high' : 'medium',
    value: stance > 0.25 ? 'risk-on' : stance < -0.25 ? 'risk-off' : 'neutral',
    detail: `VIX at ${vixNow == null ? 'n/a' : vixNow.toFixed(1)}${vixZ != null ? ` (${Math.abs(vixZ).toFixed(1)}sd ${vixZ > 0 ? 'above' : 'below'} its year average)` : ''}, credit ${creditZ > 0 ? 'bid' : 'offered'}${spreadZ != null ? `, high-yield spreads ${spreadZ > 0 ? 'wide' : 'tight'} versus the past year` : ''}.`,
    source: fred.hySpread ? 'Yahoo ^VIX + FRED high-yield OAS' : 'Yahoo ^VIX, HYG/LQD',
    proxy: 'vix',
  };
}

function inflation({ market, fred }) {
  if (fred.t5yie) {
    const v = values(fred.t5yie);
    const be = v.at(-1);
    const chg = be - (v.at(-64) ?? be);
    return {
      stance: clamp((be - 2.3) / 0.7 * 0.6 + clamp(chg / 0.3) * 0.4),
      confidence: 'high',
      value: `${be.toFixed(2)}% 5y breakeven`,
      detail: `The market is pricing ${be.toFixed(2)}% average inflation over five years, ${chg > 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(2)} points in three months.`,
      source: 'FRED T5YIE',
      proxy: 'tip',
    };
  }
  const tips = ratioSeries(market.tip, market.ief);
  const z = momentumZ(tips);
  return {
    stance: clamp(squash(z) ?? 0),
    confidence: 'proxy',
    value: z == null ? 'n/a' : z > 0.3 ? 'firming' : z < -0.3 ? 'cooling' : 'stable',
    detail: 'Inflation-protected Treasuries versus nominals - a market-implied read on breakevens. Add a FRED key for the actual breakeven series.',
    source: 'TIP/IEF ratio (proxy)',
    proxy: 'tip',
  };
}

function energy({ market }) {
  const z = momentumZ(market.crude);
  const chg = momentum(market.crude, 63);
  return {
    stance: clamp(squash(z) ?? 0),
    confidence: 'high',
    value: market.crude ? `$${values(market.crude).at(-1).toFixed(2)} WTI` : 'n/a',
    detail: `Crude ${fmt(chg, 1, '%')} over three months.`,
    source: 'Yahoo CL=F',
    proxy: 'crude',
  };
}

// There is no free live feed of geopolitical events, so this is explicitly a
// MARKET-IMPLIED stress reading: what gold, oil, defense equities and implied
// volatility are collectively pricing. The narrative layer adds named events.
function geopoliticalRisk({ market }) {
  const goldZ = momentumZ(market.gold, 21);
  const crudeZ = momentumZ(market.crude, 21);
  const vixZ = levelZ(market.vix);
  const defenseRel = ratioSeries(market.defense, market.spx);
  const defZ = momentumZ(defenseRel, 42);
  const stance = clamp(
    avg([squash(goldZ) * 0.9, squash(crudeZ) * 0.7, squash(vixZ) * 0.8, squash(defZ)]) ?? 0
  );
  const bits = [];
  if (goldZ != null) bits.push(`gold ${goldZ > 0 ? 'bid' : 'offered'}`);
  if (crudeZ != null) bits.push(`crude ${crudeZ > 0 ? 'firm' : 'soft'}`);
  if (defZ != null) bits.push(`defense shares ${defZ > 0 ? 'outperforming' : 'lagging'}`);
  return {
    stance,
    confidence: 'proxy',
    value: stance > 0.3 ? 'elevated' : stance < -0.3 ? 'subdued' : 'background',
    detail: `Market-implied stress gauge: ${bits.join(', ')}. This measures what markets are PRICING, not a feed of live events - the written analysis names the actual situations in play.`,
    source: 'Gold, crude, ITA/SPY and VIX composite',
    proxy: null,
  };
}

function cryptoFlows({ market }) {
  const etfZ = momentumZ(market.btcEtf, 21);
  const stance = clamp(squash(etfZ) ?? 0);
  return {
    stance,
    confidence: market.btcEtf ? 'medium' : 'unavailable',
    value: stance > 0.25 ? 'inflows' : stance < -0.25 ? 'outflows' : 'flat',
    detail: `Spot ETF proxy (IBIT) ${fmt(momentum(market.btcEtf, 21), 1, '%')} over a month. Price momentum in the ETF wrapper stands in for creation and redemption flow, which is not free to query.`,
    source: 'Yahoo IBIT (proxy for ETF flow)',
    proxy: 'btcEtf',
  };
}

function equityBeta({ market }) {
  const z = momentumZ(market.spx);
  return {
    stance: clamp(squash(z) ?? 0),
    confidence: 'high',
    value: `${fmt(momentum(market.spx, 63), 1, '%')} 3m`,
    detail: `The broad equity market is ${(momentum(market.spx, 63) ?? 0) > 0 ? 'advancing' : 'declining'}, which most single stocks inherit.`,
    source: 'Yahoo SPY',
    proxy: 'spx',
  };
}

export function buildFactors(inputs, assetContext = {}) {
  const factors = {
    real_rates: { id: 'real_rates', label: 'Real interest rates', ...realRates(inputs) },
    dollar: { id: 'dollar', label: 'US dollar', ...dollar(inputs) },
    yield_curve: { id: 'yield_curve', label: 'Yield curve slope', ...yieldCurve(inputs) },
    global_growth: { id: 'global_growth', label: 'Global growth cycle', ...globalGrowth(inputs) },
    china_growth: { id: 'china_growth', label: 'China / Asia industrial demand', ...chinaGrowth(inputs) },
    liquidity: { id: 'liquidity', label: 'Central bank liquidity', ...liquidity(inputs) },
    risk_appetite: { id: 'risk_appetite', label: 'Risk appetite', ...riskAppetite(inputs) },
    inflation: { id: 'inflation', label: 'Inflation expectations', ...inflation(inputs) },
    energy: { id: 'energy', label: 'Energy prices', ...energy(inputs) },
    geopolitical_risk: { id: 'geopolitical_risk', label: 'Geopolitical stress', ...geopoliticalRisk(inputs) },
    crypto_flows: { id: 'crypto_flows', label: 'Crypto-specific flows', ...cryptoFlows(inputs) },
    equity_beta: { id: 'equity_beta', label: 'Equity market beta', ...equityBeta(inputs) },
  };

  // Two factors are derived from the asset itself rather than the macro
  // universe, so they are injected by the caller.
  const { seasonalityStance, seasonalityDetail, stretchStance, stretchDetail } = assetContext;

  factors.seasonality = {
    id: 'seasonality',
    label: 'Seasonality',
    stance: seasonalityStance ?? 0,
    confidence: seasonalityStance == null ? 'unavailable' : 'medium',
    value: seasonalityStance == null ? 'n/a' : seasonalityStance > 0.1 ? 'favourable' : seasonalityStance < -0.1 ? 'unfavourable' : 'neutral',
    detail: seasonalityDetail || 'Not enough history on this timeframe for a calendar read.',
    source: "The asset's own monthly history",
    proxy: null,
  };

  factors.positioning_stretch = {
    id: 'positioning_stretch',
    label: 'Positioning stretch',
    stance: stretchStance ?? 0,
    confidence: stretchStance == null ? 'unavailable' : 'medium',
    value: stretchStance == null ? 'n/a' : stretchStance > 0.35 ? 'extended' : stretchStance < -0.35 ? 'washed out' : 'normal',
    detail: stretchDetail || 'Distance from the long-term trend, in volatility units.',
    source: 'Distance from the 200-period average',
    proxy: null,
  };

  return factors;
}
